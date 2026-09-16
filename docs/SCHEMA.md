# Database schema

MySQL 8.4, InnoDB, `utf8mb4` / `utf8mb4_unicode_ci` throughout. Eight tables.

This file describes the schema as it stands now. The definitive source is the
`migrations` slice in
[server/internal/store/store.go](../server/internal/store/store.go). That slice
is an append-only history. To find a table's present shape from it, you must
replay twenty entries in your head. Seven of those entries change
`playlist_tracks` alone. This file is the flattened result, so nobody has to do
that.

## How migrations work

`Open()` calls `migrate()` on every start. `migrate()` runs each entry whose
name is not yet in `schema_migrations`, then records that name. Four
consequences matter before you add an entry:

- **Migrations run at startup, against the live database, with no rollback.** A
  bad statement applies in part, and you find it in production, at boot. Back up
  the database first. Then rehearse the migration against a restored copy. There
  is a recipe in
  [INTEGRATIONS.md](INTEGRATIONS.md#10-implementation-order).
- **Each entry holds one statement.** The DSN does not set `multiStatements`
  (see [config.go](../server/internal/config/config.go)). An entry with two
  statements fails at runtime. Split it, as `015`/`016` and `018`/`019` do.
- **The name is the key, not the order.** If you rename an applied migration, it
  runs a second time. The slice lists `010` and `011` out of numeric
  order. This causes no problem, because `migrate()` matches on the name.
- **Write backfills so they can run twice.** A backfill that ran in part must be
  safe to re-run. Both existing backfills guard on `WHERE source_id = ''`.

A fresh database and a long-lived database migrated forward reach the same
shape. Both replay the same sequence. There is no separate "current schema" DDL
that could drift away from that sequence.

A test confirms this. It compares `information_schema` between two databases:
an empty one migrated from scratch, and a copy of production migrated forward.
Both hold 68 columns, 25 indexes and 7 foreign keys. Name, type, nullability,
default, charset, collation and index membership match in every case.

## Shape

```
users ──┬──< sessions                 (cascade)
        ├──< api_tokens               (cascade)
        ├──< playlists                (cascade, as owner)
        ├──< playlist_collaborators   (cascade)
        └──< playlist_tracks.added_by (set null)

playlists ──┬──< playlist_tracks          (cascade)
            └──< playlist_collaborators   (cascade)

track_analysis   stands alone, joined to playlist_tracks on (source, source_id)
schema_migrations  bookkeeping
```

Deleting a user removes that user's sessions, tokens, playlists and
collaborator rows. It does **not** remove tracks that user added to another
person's playlist. Instead, `added_by` becomes null and the row remains as
anonymous. A collaborator who leaves must not tear holes in a playlist somebody
else owns.

`track_analysis` has no foreign key, and this is deliberate. It is a cache
keyed by track identity, not by playlist row. One analysis therefore serves
every playlist that holds the track, and it outlives any single row.

## users

```sql
CREATE TABLE `users` (
  `id`                bigint unsigned NOT NULL AUTO_INCREMENT,
  `username`          varchar(32)     NOT NULL,
  `email`             varchar(255)    NOT NULL,
  `password_hash`     varchar(255)    NOT NULL,
  `created_at`        datetime        NOT NULL,
  `bandcamp_username` varchar(100)    DEFAULT NULL,
  `bandcamp_fan_id`   bigint unsigned DEFAULT NULL,
  `avatar_url`        varchar(500)    DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_username` (`username`),
  UNIQUE KEY `uq_users_email` (`email`)
);
```

`password_hash` holds a bcrypt hash. See
[auth/password.go](../server/internal/auth/password.go).

The `bandcamp_*` columns hold an optional profile link. The app uses that link
to choose a wishlist to browse. These columns are not credentials, and they
grant no access.

## sessions

```sql
CREATE TABLE `sessions` (
  `token_hash` char(64)        NOT NULL,
  `user_id`    bigint unsigned NOT NULL,
  `user_agent` varchar(255)    NOT NULL DEFAULT '',
  `created_at` datetime        NOT NULL,
  `expires_at` datetime        NOT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
```

The table holds only the SHA-256 of the cookie value. A database leak therefore
gives an attacker no working session.

`idx_sessions_expiry` supports `PurgeExpiredSessions`, which runs on a timer so
the table does not grow without bound.

## api_tokens

```sql
CREATE TABLE `api_tokens` (
  `id`           bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id`      bigint unsigned NOT NULL,
  `token_hash`   char(64)        NOT NULL,
  `label`        varchar(100)    NOT NULL DEFAULT '',
  `created_at`   datetime        NOT NULL,
  `last_used_at` datetime        DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_api_tokens_hash` (`token_hash`),
  KEY `idx_api_tokens_user` (`user_id`),
  CONSTRAINT `fk_api_tokens_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
```

These are long-lived bearer credentials for clients that cannot hold a cookie.
The Chrome extension is the main one. The table hashes them as `sessions` does,
but gives them **no expiry**. An extension has nowhere convenient to ask for a
new login.

A person therefore revokes a token by hand. `last_used_at` exists so that person
can tell a stale token from a live one before they revoke it.

## playlists

```sql
CREATE TABLE `playlists` (
  `id`               bigint unsigned NOT NULL AUTO_INCREMENT,
  `owner_id`         bigint unsigned NOT NULL,
  `title`            varchar(200)    NOT NULL,
  `description`      text,
  `cover_url`        varchar(500)    DEFAULT NULL,
  `visibility`       enum('private','shared','public') NOT NULL DEFAULT 'private',
  `share_token_hash` char(64)        DEFAULT NULL,
  `share_token`      varchar(32)     DEFAULT NULL,
  `sort_index`       int             NOT NULL DEFAULT '0',
  `created_at`       datetime        NOT NULL,
  `updated_at`       datetime        NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_playlists_share` (`share_token_hash`),
  KEY `idx_playlists_owner` (`owner_id`,`sort_index`),
  CONSTRAINT `fk_playlists_owner` FOREIGN KEY (`owner_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
```

`visibility` controls who may edit the playlist:

- `private`: the owner alone. The share link does nothing.
- `shared`: the owner, plus each user who opened the link while signed in.
- `public`: anyone who holds the link, signed in or not.

To disable a link that is already in circulation, the owner sets `visibility`
back to `private`.

The table stores the share token in two forms. Lookups match
`share_token_hash`. `share_token` holds the raw value, and the app returns it
only to the owner. The owner can then recover the link instead of rotating it.
Anyone with table access already holds the hash, so the plaintext beside it
costs nothing that was not already lost.

`sort_index` holds the owner's manual ordering.

The table has no cached track count and no cached duration. Each query
aggregates both values, so neither can go stale.

## playlist_tracks

This is the central table, and it carries the most history.

```sql
CREATE TABLE `playlist_tracks` (
  `id`           bigint unsigned NOT NULL AUTO_INCREMENT,
  `playlist_id`  bigint unsigned NOT NULL,
  `position`     int             NOT NULL,

  -- identity: which integration, and its own id for the track
  `source`       varchar(16)     NOT NULL DEFAULT 'bandcamp',
  `source_id`    varchar(64)     NOT NULL DEFAULT '',
  `source_ref`   varchar(64)     DEFAULT NULL,

  -- legacy Bandcamp-only identity, NULL on rows from any other source
  `bc_track_id`  bigint unsigned DEFAULT NULL,
  `bc_album_id`  bigint unsigned DEFAULT NULL,
  `bc_band_id`   bigint unsigned DEFAULT NULL,

  `title`        varchar(300)    NOT NULL,
  `artist`       varchar(300)    NOT NULL,
  `album_title`  varchar(300)    DEFAULT NULL,
  `duration`     double          NOT NULL DEFAULT '0',

  -- hand-entered, always win over detected values
  `bpm`          double          DEFAULT NULL,
  `key_override` varchar(8)      DEFAULT NULL,
  `note`         varchar(280)    DEFAULT NULL,

  `art_id`       bigint unsigned DEFAULT NULL,
  `art_url`      varchar(500)    DEFAULT NULL,
  `track_url`    varchar(500)    NOT NULL DEFAULT '',
  `added_by`     bigint unsigned DEFAULT NULL,
  `added_at`     datetime        NOT NULL,

  PRIMARY KEY (`id`),
  KEY `idx_tracks_playlist` (`playlist_id`,`position`),
  KEY `fk_tracks_user` (`added_by`),
  KEY `idx_tracks_source` (`source`,`source_id`),
  CONSTRAINT `fk_tracks_playlist` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_tracks_user`     FOREIGN KEY (`added_by`)    REFERENCES `users` (`id`)     ON DELETE SET NULL
);
```

### Two identities, one of them on the way out

`(source, source_id)` is the real identity. `source` names the integration.
`source_id` holds that integration's own id for the track, as text. Text is
necessary because the sources disagree about what an id is. Bandcamp ids are
64-bit integers. YouTube ids are 11 characters of base64url.

`source_ref` holds an opaque handle that the integration needs to act on the
track later. For Bandcamp this is the band id, which the server needs to
resolve a stream URL. The handle means nothing to any other code.

The `bc_*` columns hold the older Bandcamp-only identity. The server still
writes them for Bandcamp rows, so existing clients keep working. They are
**null on every row from any other source**.

Migration `017` dropped `NOT NULL` from `bc_track_id` for that reason. A value
of `0` would have been a lie, and no later migration could tell that lie apart
from real data.

These columns are obsolete. They go away once the web app and the extension read
the neutral fields instead.

### Art splits the same way, but on purpose

`art_id` holds Bandcamp's artwork id. A client builds a CDN URL from it at
whatever pixel size a given view needs.

`art_url` holds a ready image URL, for sources that expose no id.

An id beats a URL wherever one exists, because a stored URL forces one size on
every view. Both columns therefore stay. Each row sets exactly one of them.

### Overrides stay apart from detection

`bpm`, `key_override` and `note` hold hand-entered values. They always win over
whatever `track_analysis` found. Because the two live in separate places,
re-analysing a track never discards a correction somebody typed.

Migration `012` cleaned up rows from before that separation existed. Detection
wrote straight into `bpm` at the time, and those values rendered as though a
person entered them.

### Position

`position` is dense, and a reorder rewrites it in full. An append reads
`MAX(position)` under `FOR UPDATE`. Two collaborators who add at the same time
therefore cannot land on the same slot.

## track_analysis

```sql
CREATE TABLE `track_analysis` (
  `source`           varchar(16)     NOT NULL DEFAULT 'bandcamp',
  `source_id`        varchar(64)     NOT NULL DEFAULT '',
  `analyzer_version` int             NOT NULL,
  `bpm`              double          DEFAULT NULL,
  `bpm_confidence`   double          DEFAULT NULL,
  `key_name`         varchar(24)     DEFAULT NULL,
  `key_camelot`      varchar(8)      DEFAULT NULL,
  `key_tonic`        tinyint         DEFAULT NULL,
  `key_scale`        varchar(8)      DEFAULT NULL,
  `key_confidence`   double          DEFAULT NULL,
  `peaks`            varbinary(2048) DEFAULT NULL,
  `analyzed_at`      datetime        NOT NULL,
  PRIMARY KEY (`source`,`source_id`)
);
```

This table holds detected tempo, key and waveform. The browser computes them and
writes them back, so nobody downloads and analyses the same audio twice.

The key is track identity, not playlist row. The audio behind a given track is
the same wherever that track appears.

On read, the server compares `analyzer_version` against `store.AnalyzerVersion`
and treats older rows as absent. Raising that constant therefore invalidates
stale results without deleting anything. The join in `Tracks()` and the analysis
handlers read the same constant, so the two cannot disagree.

`peaks` holds one byte per bucket. The app draws the waveform a few pixels tall,
so 8 bits of amplitude is enough, and it keeps a row well under a kilobyte. The
API limits writes to 2048 bytes, to match the column.

Rows exist only for sources that report `analyze: true` from
`GET /api/sources`. The server refuses writes for any other source. Nobody could
have measured those numbers, and they drive a visible BPM column.

## playlist_collaborators

```sql
CREATE TABLE `playlist_collaborators` (
  `playlist_id` bigint unsigned NOT NULL,
  `user_id`     bigint unsigned NOT NULL,
  `added_at`    datetime        NOT NULL,
  PRIMARY KEY (`playlist_id`,`user_id`),
  KEY `idx_collab_user` (`user_id`),
  CONSTRAINT `fk_collab_playlist` FOREIGN KEY (`playlist_id`) REFERENCES `playlists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_collab_user`     FOREIGN KEY (`user_id`)     REFERENCES `users` (`id`)     ON DELETE CASCADE
);
```

This table records who may edit a playlist, apart from the owner. The composite
primary key makes each membership unique on its own.

`idx_collab_user` serves the reverse lookup, "which playlists am I on". Listing
a user's playlists uses that lookup.

## schema_migrations

```sql
CREATE TABLE `schema_migrations` (
  `name`       varchar(128) NOT NULL,
  `applied_at` datetime     NOT NULL,
  PRIMARY KEY (`name`)
);
```

One row records one applied migration. `name` is the key, so restarts stay
cheap. Order in the slice sets the run order. The numeric prefix does not.

## Applied migrations

```
001_users                     011_track_key_override
002_sessions                  012_clear_auto_bpm_overrides
003_playlists                 013_track_note
004_playlist_tracks           014_api_tokens
005_collaborators             015_track_source
006_drop_base_fan             016_backfill_track_source
007_share_token_plain         017_track_source_key
008_user_profile              018_analysis_source
009_track_bpm                 019_backfill_analysis_source
010_track_analysis            020_analysis_source_pk
```

## How to regenerate this file

Nobody wrote the DDL above by hand. It came from a real database. To refresh it
after you add migrations, migrate an empty database and dump it:

1. Start MySQL:
   ```sh
   docker run -d --name schemadb -e MYSQL_ROOT_PASSWORD=schema mysql:8.4
   ```
2. Wait for `init process done` in the logs before you connect.
3. Create the database:
   ```sh
   docker exec schemadb mysql -u root -pschema -e "CREATE DATABASE fresh"
   ```
4. Point a server at that database, so `migrate()` runs.
5. Dump the result:
   ```sh
   docker exec schemadb mysqldump -u root -pschema --no-data --skip-comments fresh
   ```

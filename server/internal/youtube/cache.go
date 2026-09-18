package youtube

import (
	"sync"
	"time"
)

// ttlCache is a small map that forgets entries after a while.
//
// Two things here are worth caching and neither is worth a dependency: a
// resolved audio url, which costs an extractor run, and a search response,
// which costs 100 of the 10,000 daily quota units. Both are read far more often
// than they are written, and a miss is always safe.
type ttlCache[T any] struct {
	mu sync.Mutex
	m  map[string]cacheEntry[T]
}

type cacheEntry[T any] struct {
	val     T
	expires time.Time
}

// maxCacheEntries bounds the map. It is swept when it grows past this, rather
// than by a background goroutine, because a cache nobody is writing to is also
// a cache nobody needs swept.
const maxCacheEntries = 512

func newTTLCache[T any]() *ttlCache[T] {
	return &ttlCache[T]{m: make(map[string]cacheEntry[T])}
}

func (c *ttlCache[T]) get(key string) (T, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.m[key]
	if !ok || time.Now().After(e.expires) {
		var zero T
		return zero, false
	}
	return e.val, true
}

func (c *ttlCache[T]) set(key string, val T, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	if len(c.m) >= maxCacheEntries {
		for k, e := range c.m {
			if now.After(e.expires) {
				delete(c.m, k)
			}
		}
		// Everything was still live, which means the bound is the real limit
		// rather than a stale-entry problem. Start over: losing a cache is a
		// slow request, where growing without limit is a leak.
		if len(c.m) >= maxCacheEntries {
			clear(c.m)
		}
	}
	c.m[key] = cacheEntry[T]{val: val, expires: now.Add(ttl)}
}

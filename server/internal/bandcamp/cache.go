package bandcamp

import (
	"sync"
	"time"
)

type entry struct {
	val     any
	expires time.Time
}

// cache is a small TTL map. Bandcamp metadata barely changes, so caching keeps
// the sidebar and album expansion snappy and keeps us from hammering their API.
type cache struct {
	mu sync.RWMutex
	m  map[string]entry
}

func newCache() *cache {
	c := &cache{m: make(map[string]entry)}
	go c.reap()
	return c
}

func (c *cache) get(key string) (any, bool) {
	c.mu.RLock()
	e, ok := c.m[key]
	c.mu.RUnlock()
	if !ok || time.Now().After(e.expires) {
		return nil, false
	}
	return e.val, true
}

func (c *cache) set(key string, val any, ttl time.Duration) {
	c.mu.Lock()
	c.m[key] = entry{val: val, expires: time.Now().Add(ttl)}
	c.mu.Unlock()
}

func (c *cache) reap() {
	for range time.Tick(5 * time.Minute) {
		now := time.Now()
		c.mu.Lock()
		for k, e := range c.m {
			if now.After(e.expires) {
				delete(c.m, k)
			}
		}
		c.mu.Unlock()
	}
}

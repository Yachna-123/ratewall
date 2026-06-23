-- check_and_increment.lua
--
-- Implements the sliding window counter's read-and-maybe-increment as a
-- SINGLE atomic Redis operation. Redis executes Lua scripts to completion
-- without interleaving any other client's commands in between — this is
-- what actually prevents the check-then-act race condition under
-- concurrent load from multiple app instances hitting the same Redis.
--
-- Without this script, the naive approach (GET curr, GET prev, compute,
-- then SET/INCR) is FOUR separate round trips. Two concurrent clients can
-- both finish their GETs (both see count=0) before either commits an
-- INCR, letting both requests through even if max=1. Wrapping the whole
-- sequence in one Lua script collapses it into a single round trip that
-- Redis guarantees runs without interruption.
--
-- KEYS[1] = current window key   e.g. "rw:{key}:1042"
-- KEYS[2] = previous window key  e.g. "rw:{key}:1041"
-- ARGV[1] = prevWeight  (float, 0..1)
-- ARGV[2] = max         (integer)
-- ARGV[3] = windowMs    (integer, used for TTL so abandoned keys expire)
--
-- Returns: { allowed (1 or 0), weightedCountBefore * 1000 (as integer,
--            scaled to avoid Lua/Redis float-return precision issues) }

local currKey = KEYS[1]
local prevKey = KEYS[2]
local prevWeight = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local windowMs = tonumber(ARGV[3])

local currCount = tonumber(redis.call('GET', currKey)) or 0
local prevCount = tonumber(redis.call('GET', prevKey)) or 0

local weightedCount = currCount + (prevCount * prevWeight)

if weightedCount >= max then
  return { 0, math.floor(weightedCount * 1000) }
end

local newCurrCount = redis.call('INCR', currKey)
-- TTL covers this window plus the next, so it self-expires even if a key
-- is never touched again — avoids unbounded key growth for one-off callers.
redis.call('PEXPIRE', currKey, windowMs * 2)

local finalWeightedCount = newCurrCount + (prevCount * prevWeight)

return { 1, math.floor(finalWeightedCount * 1000) }

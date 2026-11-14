/**
 * Token bucket over two keys in one Lua script. Redis runs a script to the end before it runs any
 * other command, so "read the tokens, decide, write the tokens" cannot interleave with another
 * request doing the same: two callers can never both see the last token. Done in two round trips
 * from Node (GET, then SET), both would read 1, both would pass and both would write 0.
 *
 * Each key is a hash { tokens, ts }. Nothing refills in the background: the script adds what the
 * time since `ts` is worth (capped at capacity) when the key is next read. A key that does not
 * exist is a full bucket, and keys expire once they would be full again, so idle users cost nothing.
 *
 * The clock is Redis's own (TIME), not the API's: several API instances with drifting clocks would
 * otherwise add or remove tokens from each other's view. Since Redis 7 a script that writes after
 * TIME is replicated by its effects, so replicas store the same values.
 *
 * KEYS[1] user bucket, KEYS[2] tenant bucket.
 * ARGV: user capacity, user window ms, tenant capacity, tenant window ms.
 * Returns { allowed (1/0), retry after ms, user remaining, user full in ms, tenant remaining,
 * tenant full in ms }, all integers (Redis truncates Lua numbers in a reply, so they are rounded
 * here on purpose).
 */
export const TOKEN_BUCKET_LUA = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

local function refill(key, capacity, window_ms)
  local stored = redis.call('HMGET', key, 'tokens', 'ts')
  local tokens = tonumber(stored[1])
  local ts = tonumber(stored[2])
  if tokens == nil or ts == nil then
    return capacity
  end
  local elapsed = math.max(0, now - ts)
  return math.min(capacity, tokens + elapsed * capacity / window_ms)
end

local function wait_ms(tokens, need, capacity, window_ms)
  if tokens >= need then
    return 0
  end
  return math.ceil((need - tokens) * window_ms / capacity)
end

local function save(key, tokens, capacity, window_ms)
  redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('PEXPIRE', key, wait_ms(tokens, capacity, capacity, window_ms) + 1000)
end

local user_capacity = tonumber(ARGV[1])
local user_window = tonumber(ARGV[2])
local tenant_capacity = tonumber(ARGV[3])
local tenant_window = tonumber(ARGV[4])

local user = refill(KEYS[1], user_capacity, user_window)
local tenant = refill(KEYS[2], tenant_capacity, tenant_window)

local allowed = 0
local retry = 0
if user >= 1 and tenant >= 1 then
  allowed = 1
  user = user - 1
  tenant = tenant - 1
else
  retry = math.max(wait_ms(user, 1, user_capacity, user_window),
                   wait_ms(tenant, 1, tenant_capacity, tenant_window))
end

save(KEYS[1], user, user_capacity, user_window)
save(KEYS[2], tenant, tenant_capacity, tenant_window)

return {
  allowed,
  retry,
  math.floor(user),
  wait_ms(user, user_capacity, user_capacity, user_window),
  math.floor(tenant),
  wait_ms(tenant, tenant_capacity, tenant_capacity, tenant_window),
}
`;

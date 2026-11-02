# 排查：登录后报 "session time out"

## 现象

- 部署方式：Docker 容器（无外部代理，浏览器直连服务）
- **注册用户**：正常
- **登录**：页面提示 session time out（"Your session expired. Please log in again."），怎么登录都不行
- `docker logs -f` 无报错

## 认证链路

登录成功后，前端依次执行：

```
1. fetch POST /api/auth/login       ← 直接 fetch，不需要 token，成功返回 token
2. setSession(user, token)          ← token 写入 localStorage + React state
3. checkOnboardingStatus()
   └─ authenticatedFetch GET /api/user/onboarding-status
      ├─ getStoredAuthToken()       ← 从 localStorage 读取 token
      ├─ isAuthTokenExpired(token)  ← ★ 客户端时钟检查（此处可能是 bug）
      └─ fetch 带 Authorization: Bearer <token>
         └─ 服务端 authenticateToken 中间件 ★ 服务端 JWT 验证
```

### 关键客户端检查 (`src/utils/api.js`)

```js
// api.js:51-53
export const isAuthTokenExpired = (token) => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt + TOKEN_EXPIRY_SKEW_MS : false;
};

// api.js:102-109
export const getStoredAuthToken = () => {
  const token = localStorage.getItem('auth-token');
  if (token && isAuthTokenExpired(token)) {
    expireAuthSession();   // ← 直接清掉 token
    return null;
  }
  return token;
};
```

### 关键服务端检查 (`server/modules/auth/auth.middleware.ts`)

```ts
const decoded = jwt.verify(token, JWT_SECRET);
```

### 触发 "session expired" 的路径

| # | 触发位置 | 机制 |
|---|---------|------|
| 1 | `isAuthTokenExpired()` | 客户端：浏览器 `Date.now()` 比较 token 的 `exp` 时间戳 |
| 2 | `authenticatedFetch` 收到 `X-Auth-Error` 响应头 | 服务端 `jwt.verify()` 失败 → 返回 401 + `X-Auth-Error` → 前端清 session |
| 3 | WebSocket 连接 | 同 `isAuthTokenExpired()` (`WebSocketContext.tsx:59`) |

## 最可能的原因：服务器宿主机与浏览器时钟偏差

### Docker 时钟机制

Docker 容器**没有独立时钟**，直接共享宿主机内核时钟。容器内的 `TZ` 环境变量只影响日期时间的**显示格式**，JWT 使用 Unix 时间戳（从 1970-01-01 00:00:00 UTC 算起的秒数），**与时区完全无关**。

因此：**如果有时钟问题，一定是服务器宿主机 vs 浏览器所在机器的时差。**

### 导致问题的场景

- **宿主机时钟比浏览器快超过 24 小时** → 签出的 `exp` 从浏览器看已经过期 → `isAuthTokenExpired` 立刻判定过期 → 前端清 token
- **宿主机时钟比浏览器快很多（但不到 24 小时）** → 签出的 `iat` 是"未来时间"，token 通过客户端检查但可能被服务端拒绝（取决于偏差程度）

## 已添加的诊断日志

以下日志已加到代码中。重新 `npm run build` + 重建镜像后生效。

### 服务端日志 (`docker logs -f`)

#### 数据库权限诊断 (`connection.ts`)
```
[db] getConnection: DATABASE_PATH=/home/rdcli/.rdcli/auth.db
[db] getConnection: process uid=1000 gid=1000 home=/home/rdcli
[db] getConnection: dbDir=/home/rdcli/.rdcli mode=755 uid=1000 gid=1000
[db] getConnection: dbDir is readable + writable by current user
[db] getConnection: existing db file mode=644 uid=1000 gid=1000 size=8192
[db] getConnection: existing db file is readable + writable by current user
```

#### JWT 密钥持久性诊断 (`app-config.ts`)
```
[app-config] JWT secret EXISTS in db (length=128, first 4 hex chars=a1b2)
# 如果密钥是新建（之前丢失了）：
[app-config] JWT secret CREATED (length=128, first 4 hex chars=a1b2)
```
**判定**：如果每次启动都看到 `CREATED`，说明 auth.db 没被正确持久化。

#### JWT 密钥来源 (`auth.middleware.ts`)
```
[auth] JWT_SECRET source=app_config(jwt_secret) (length=128, first 4 hex=a1b2)
```

#### 每次带 token 的请求 (`auth.middleware.ts`) ★ 核心
```
[auth] authenticateToken: serverNow=1730567890, token.iat=1730300000, token.exp=1730386400, userId=1
[auth] authenticateToken: token age=267890s, ttl=18110s (iat=267890s ago, exp=in 18110s)
```
时钟问题时会看到 WARN：
```
[auth] authenticateToken: token appears EXPIRED by server clock (ttl=-12345s)
[auth] authenticateToken: token iat is 86400s IN THE FUTURE — server clock may be behind client
```
**判定关键**：看 `serverNow`、`token.iat`、`token.exp`、`age`、`ttl`。
- `age` 应该是几秒（刚签发）→ 如果是负的或非常大，时钟有问题
- `ttl` 应该接近 86400（24 小时）→ 如果是负的，token 已过期

#### JWT verify 失败 (`auth.middleware.ts`)
```
[auth] authenticateToken: JWT EXPIRED — serverNow=..., token.iat=..., token.exp=... (expired ...s ago)
[auth] authenticateToken: JWT VERIFY FAILED — invalid signature (serverNow=..., token.iat=..., token.exp=...)
```
**判定**：`invalid signature` 说明 JWT_SECRET 不一致（可能 auth.db 丢失后重建了密钥）。

#### 登录路由 (`auth.routes.ts`)
```
[auth] POST /login: username=xxx, serverNow=1730567890, ip=::ffff:192.168.1.x
[auth] POST /login: success for username=xxx, token.userId=1, serverNow=1730567890
[auth] POST /login: failed (username=xxx): Invalid username or password
```

#### 登录失败分支 (`auth.service.ts`)
```
[auth] login: user NOT FOUND for username='xxx' (lookup+bccompareMs=2)
[auth] login: password MISMATCH for username='xxx' (bcrypt compareMs=48)
```

#### 用户工作区创建 (`user-workspace.service.ts`)
```
[user-workspace] ensureUserWorkspace userId=1 -> path=/home/rdcli/.rdcli/users/1
[user-workspace] parent dir stat: mode=755 uid=1000 gid=1000
[user-workspace] ensureUserWorkspace userId=1: directory ensured at /home/rdcli/.rdcli/users/1
# 失败时：
[user-workspace] ensureUserWorkspace userId=1: FAILED to create ... — Error: EACCES ...
```

### 前端日志（浏览器 DevTools Console）

登录后在 Console 中会自动输出：

#### 客户端判定 token 过期
```
[auth:client] isAuthTokenExpired: token APPARENTLY EXPIRED (ttlMs=-12345000, ageMs=24567000) {iat: '...', exp: '...', now: '...'}
[auth:client] isAuthTokenExpired: token near expiry (ttlMs=30000, ageMs=86370000) {iat: '...', exp: '...', now: '...'}
```
**判定**：看 `ttlMs`。正常登录后的 token ttl 应该大约 86400000（24h 的毫秒数）。如果 `ttlMs` 是负数，说明浏览器认为 token 已过期。同时看 dia 对象的 `iat`、`exp`、`now` 三个 ISO 时间字符串。

#### expireAuthSession 调用栈
```
[auth:client] expireAuthSession: clearing token from localStorage (trace follows)
console.trace [auth:client] expireAuthSession call stack
    at expireAuthSession (api.js:94)
    at api.js:153              ← 调用来源
    at ...
```
**判定**：调用栈显示是 `authenticatedFetch` 触发的（响应头原因），还是 `getStoredAuthToken`/`isAuthTokenExpired` 触发的（客户端时钟原因）。

#### 服务端返回 X-Auth-Error
```
[auth:client] authenticatedFetch: received X-Auth-Error=invalid-token for /api/user/onboarding-status (status=401), clearing session
```

### 如何对照分析

1. 服务器上 `docker logs -f | grep '\[auth\]'`
2. 浏览器 Console 看 `[auth:client]` 输出
3. **两边对照**：
   - `serverNow` vs 浏览器 `now` → 差多少秒？
   - token 的 `iat`/`exp` 在两边看是一样的值（因为来自同一个 JWT）
   - 哪一端先报"过期"？

## 验证步骤

### 1. 检查时钟

在服务器上执行：

```bash
# 容器内时间和 Unix 时间戳
docker exec rd-cli date '+%Y-%m-%d %H:%M:%S %Z  (epoch=%s)'

# 宿主机时间
date '+%Y-%m-%d %H:%M:%S %Z  (epoch=%s)'

# 宿主机时间同步状态
timedatectl status
```

在**浏览器所在机器**上也执行对应命令。对比三者的 `epoch` 值（Unix 时间戳），差多少秒。

### 2. 容器内直接测试认证接口

```bash
# 替换 YOUR_USERNAME / YOUR_PASSWORD
TOKEN=$(docker exec rd-cli curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}' | jq -r '.token')

echo "Token: $TOKEN"

# 解码 token 看 iat 和 exp
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool 2>/dev/null | grep -E 'iat|exp'

# 容器内用 token 调用 onboarding-status
docker exec rd-cli curl -s http://localhost:3001/api/user/onboarding-status \
  -H "Authorization: Bearer $TOKEN"
```

如果容器内返回正常（200，有 JSON），说明**服务器端 JWT 验证没问题**，问题在客户端检查。

### 3. 浏览器端诊断

打开 DevTools → Console，登录后会有 `[auth:client]` 前缀的日志自动输出。

也可以手动执行：

```js
const t = localStorage.getItem('auth-token');
if (t) {
  const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  console.log('iat:', new Date(p.iat * 1000).toISOString());
  console.log('exp:', new Date(p.exp * 1000).toISOString());
  console.log('now:', new Date().toISOString());
  console.log('浏览器认为过期:', Date.now() >= p.exp * 1000 + 60000);
}
```

如果 `浏览器认为过期: true`，就是时钟问题。

### 4. 浏览器 Network 面板

打开 DevTools → Network，登录后观察 `/api/user/onboarding-status` 这个请求：

- **Request Headers**：确认 `Authorization` 头已带上
- **Response Headers**：检查是否有 `X-Auth-Error`，值是什么
- **Response Status**：看是 200 还是 401

## 如果确认是时钟问题

**短期修复**：在服务器宿主机上启用 NTP 时间同步，确保与客户端时钟一致。

```bash
# 检查 NTP 状态
timedatectl show-timesync

# 启用 NTP
sudo timedatectl set-ntp true
```

**代码层面可改进**（`src/utils/api.js`）：

当前 `isAuthTokenExpired` 只检查 `exp`，不检查 `iat`。如果 `iat` 是未来时间（时钟不同步），应当也视为可疑：

```js
// 如果签发时间在未来（时钟不同步），视为过期
if (claims.iat * 1000 > Date.now() + TOKEN_EXPIRY_SKEW_MS) {
  return true;
}
```

以及把错误的 UI 文案做得更明确（区分"token 未生成"和"token 已过期"），而不是统一显示 session time out。

## 如果确认是 JWT 密钥丢失问题

每次容器重建 auth.db 丢失 → `app_config` 表为空 → `getOrCreateJwtSecret()` 生成新密钥 → 旧 token 全都验证失败 → `invalid signature`。

日志中会看到：
```
[app-config] JWT secret CREATED (length=128, first 4 hex chars=xxxx)
[auth] authenticateToken: JWT VERIFY FAILED — invalid signature ...
```

**修复**：确保 auth.db 持久化到宿主机卷（bind-mount `~/.rdcli` 目录），或设置 `JWT_SECRET` 环境变量固定密钥。

## 如果不是以上问题

其他可能：

1. **bcrypt 模块问题**：bcrypt 是 native 模块，如果容器架构（arm64 vs amd64）不匹配可能行为异常，但注册正常 → bcrypt 工作正常，可排除。

2. **浏览器缓存**：换个浏览器或无痕模式试一下。
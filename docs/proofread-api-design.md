# 核稿 API 设计文档

## 概述

rdCLI 提供两种核稿模式：

| 模式 | 端点 | 交互方式 |
|------|------|----------|
| **异步任务** | `POST /api/proofread` | 提交 docx → 后台核稿 → 回调通知结果 |
| **会话跳转** | `POST /api/proofread/session` | 提交 docx → 返回聊天链接 → 用户跳转交互 |

核稿标准完全定义在容器的全局 `CLAUDE.md`（「文稿校对审读」章节）中，Claude 启动时自动加载，根据文档内容自行判断适用标准。

---

## 通用约定

### 鉴权

所有 API 端点通过 API Key 鉴权（Platform 模式免鉴权，使用默认用户）：

```
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Platform 模式下可以不传 `x-api-key`。

### 响应格式

成功：

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "task_id": "pt-xxxxxxxx-xxxxxxxx",
  "data": { ... }
}
```

失败：

```json
{
  "code": 401,
  "timestamp": "2026-10-24 18:52:57",
  "message": "API Key 无效或已禁用",
  "data": { }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | number | `0` 表示成功，失败时等于 HTTP 状态码（400/401/404/500 等） |
| `timestamp` | string | 服务器当前时间，UTC+8，`YYYY-MM-DD HH:MM:SS` |
| `message` | string | 成功固定为 `"success"`，失败为错误描述 |
| `task_id` | string | 任务 ID，仅异步任务相关端点返回 |
| `data` | object | 业务数据，成功时承载结果，失败时通常为空对象 |

### 错误码

| code | 场景 |
|------|------|
| `0` | 成功 |
| `400` | 参数缺失/不合法、文件缺失、格式不支持、文件超限 |
| `401` | 未提供 API Key、API Key 无效或已禁用 |
| `404` | 任务不存在 |
| `429` | 同时处理的任务数超过上限（5 个） |
| `500` | 服务器内部错误、核稿失败 |

---

## POST /api/proofread — 异步核稿

提交 docx，后台异步核稿，完成后回调 `callback_url`（如果提供）；若未提供，通过查询接口轮询获取结果。

### 请求

```
POST /api/proofread
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: multipart/form-data
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | Word 文档（.docx），最大 20MB |
| `callback_url` | string | 否 | 核稿完成后回调地址，`http://` 或 `https://`，不传则通过轮询获取结果 |
| `additional_instructions` | string | 否 | 追加核稿要求 |

### 响应 (200)

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "task_id": "pt-mvm96saj-f05b09a4",
  "data": {
    "task_id": "pt-mvm96saj-f05b09a4",
    "status": "pending"
  }
}
```

### 回调

核稿完成后，如果提交时提供了 `callback_url`，会收到一个 POST 请求（失败时自动重试，最多 4 次：2s / 5s / 15s / 30s 超时）。

回调请求体：

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "task_id": "pt-mvm96saj-f05b09a4",
  "data": {
    "status": "completed",
    "file_name": "中国石油天然气零售系统密钥管理及发行软件建设方案-终稿.docx",
    "file_size": 4173832,
    "created_at": "2026-10-24 18:25:51",
    "updated_at": "2026-10-24 18:29:00",
    "result_text": "……核稿结果 Markdown……",
    "tokens": {
      "inputTokens": 12345,
      "outputTokens": 6789,
      "cacheReadTokens": 0,
      "cacheCreationTokens": 0,
      "totalTokens": 19134
    },
    "session_id": "pt-mvm96saj-f05b09a4",
    "session_url": "http://rdcli-host/session/pt-mvm96saj-f05b09a4"
  }
}
```

失败回调：

```json
{
  "code": 1,
  "timestamp": "2026-10-24 18:52:57",
  "message": "核稿处理异常：Claude 未返回任何结果",
  "task_id": "pt-mvm96saj-f05b09a4",
  "data": {
    "status": "failed",
    "file_name": "…….docx",
    "file_size": 4173832,
    "created_at": "2026-10-24 18:25:51",
    "updated_at": "2026-10-24 18:29:00",
    "error_message": "核稿处理异常：Claude 未返回任何结果"
  }
}
```

`data.status` 取值：`completed`（完成）、`failed`（失败）、`cancelled`（已撤销）。

---

## GET /api/proofread/task?id=xxx — 查询单个任务

### 请求

```
GET /api/proofread/task?id=pt-mvm96saj-f05b09a4
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 响应 (200)

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "task_id": "pt-mvm96saj-f05b09a4",
  "data": {
    "status": "completed",
    "file_name": "…….docx",
    "file_size": 4173832,
    "created_at": "2026-10-24 18:25:51",
    "updated_at": "2026-10-24 18:29:00",
    "result_text": "……",
    "tokens": { ... },
    "session_id": "pt-mvm96saj-f05b09a4",
    "session_url": "http://rdcli-host/session/pt-mvm96saj-f05b09a4"
  }
}
```

### 响应 (404)

```json
{
  "code": 404,
  "timestamp": "2026-10-24 18:52:57",
  "message": "任务不存在"
}
```

---

## GET /api/proofread/task — 查看进行中的任务

### 请求

```
GET /api/proofread/task
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 响应 (200)

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "data": {
    "tasks": [
      {
        "task_id": "pt-mvm96saj-f05b09a4",
        "status": "processing",
        "file_name": "…….docx",
        "file_size": 4173832,
        "additional_instructions": null,
        "created_at": "2026-10-24 18:25:51",
        "updated_at": "2026-10-24 18:29:00"
      }
    ]
  }
}
```

仅返回 `pending` 和 `processing` 状态的任务，最多 50 条，按创建时间倒序。

---

## DELETE /api/proofread/task?id=xxx — 撤销任务

### 请求

```
DELETE /api/proofread/task?id=pt-mvm96saj-f05b09a4
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 响应 (200)

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "task_id": "pt-mvm96saj-f05b09a4",
  "data": {
    "status": "cancelled",
    "updated_at": "2026-10-24 18:29:00"
  }
}
```

只有 `pending` 和 `processing` 状态的任务可撤销。撤销后，若任务正在核稿，底层 Claude 会话会被中止。

---

## POST /api/proofread/session — 创建会话跳转

上传 docx → 创建核稿会话 → 返回链接，用户点击跳转到 rdCLI 聊天界面完成核稿。

### 请求

```
POST /api/proofread/session
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: multipart/form-data
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | Word 文档（.docx），最大 20MB |
| `additional_instructions` | string | 否 | 用户追加的核稿要求 |

### 响应 (200)

```json
{
  "code": 0,
  "timestamp": "2026-10-24 18:52:57",
  "message": "success",
  "data": {
    "session_id": "abc123-def456",
    "session_url": "http://rdcli-host/session/abc123-def456"
  }
}
```

返回的 `session_id` 就是正常的聊天会话，用户可以继续对话、追问、追加指令。

---

## 服务端处理流程

```
POST /api/proofread（或 /api/proofread/session）
│
├─ 1. multer 接收文件 → 存入 ~/.rdcli/assets/<userId>/
│
├─ 2. 异步模式：创建 proofread_tasks 记录（pending），返回 taskId
│     会话模式：直接创建 Claude session，返回 session_url
│
├─ 3. 异步模式后台执行：
│     pending → processing → 驱动 Claude（providerRuntimeService.run）
│     permissionMode: 'bypassPermissions'
│     User Message: "请校对审读这篇文档。" + 文档引用
│                    + (additional_instructions)
│                    + "请以 Markdown 格式输出审核意见。"
│
├─ 4. 收集 assistant 文本 + token 用量
│
└─ 5. 异步模式：completed/failed 后回调 callback_url
```

### 关键细节

- **docx 不预解析**：Claude 有 Read 工具，可以自己读取 Word 文档。
- **会话持续有效**：session 模式下返回的 session_id 就是正常聊天会话。
- **鉴权**：复用 `validateExternalApiKey` 中间件，支持 API Key 和 Platform 两种模式。

---

## 技术实现

### 新增文件

```
server/modules/proofread/
├── index.ts                  # 模块入口 barrel
├── proofread.module.ts       # 组装依赖 → 导出 router
├── proofread.routes.ts       # 路由 + 响应包络
└── proofread.service.ts      # 会话/任务编排、回调投递
```

```
server/modules/database/repositories/proofread-tasks.ts   # 任务仓储
```

### 数据库表

`proofread_tasks`：

| 字段 | 说明 |
|------|------|
| `task_id` | 主键，任务/会话 ID |
| `user_id` | 所属用户 |
| `status` | `pending` / `processing` / `completed` / `failed` / `cancelled` |
| `file_name` / `file_size` / `file_path` | 上传文件信息 |
| `additional_instructions` | 追加核稿要求 |
| `callback_url` | 异步模式回调地址 |
| `session_id` | provider-native 会话 ID |
| `result_text` / `tokens_json` | 核稿结果与 token 用量 |
| `error_message` | 失败原因 |
| `created_at` / `updated_at` | 时间戳（UTC，序列化时转 UTC+8） |

### 依赖

- **零新增 npm 依赖**
- `multer`：文件上传
- `providerRuntimeService.run()`：驱动 Claude 会话

---

## OA 系统集成示例

```bash
# 异步核稿：
curl -X POST https://rdcli.example.com/api/proofread \
  -H "x-api-key: ck_xxxx" \
  -F "file=@来文登记.docx" \
  -F "callback_url=https://oa.example.com/api/proofread/callback" \
  -F "additional_instructions=请重点检查涉及财政数据的表述"

# 响应：
# { "code": 0, "message": "success", "task_id": "pt-xxxx", "data": { "status": "pending" } }

# 会话跳转：
curl -X POST https://rdcli.example.com/api/proofread/session \
  -H "x-api-key: ck_xxxx" \
  -F "file=@来文登记.docx"

# 响应：
# { "code": 0, "data": { "session_id": "abc123", "session_url": "https://rdcli.example.com/session/abc123" } }
```

---

## 审阅记录

| 日期 | 审阅人 | 意见 |
|------|--------|------|
| 2025-01-15 | — | 初稿（会话跳转方案） |
| 2026-10-24 | — | 增加异步任务模式；统一响应包络（code/timestamp/message/task_id/data）；时间戳转 UTC+8 |

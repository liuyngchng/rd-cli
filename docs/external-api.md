# rdCLI 外部 API 文档

rdCLI 提供 HTTP API，允许外部程序通过 API Key 提交文档或代码任务给 Claude Code 处理。

---

## 目录

- [鉴权方式](#鉴权方式)
- [API 1：文档核稿（异步回调/轮询）](#api-1文档核稿异步回调) — 提交文档，核稿完成后可回调推送或轮询获取 Markdown 核稿意见
- [API 2：文档核稿（会话跳转）](#api-2文档核稿会话跳转) — 提交文档，返回聊天链接供人工复核
- [API 3：通用 Agent](#api-3通用-agent) — 触发 Claude 操作代码仓库
- [获取 API Key](#获取-api-key)
- [附录](#附录)

---

## 鉴权方式

所有 API 均通过 `x-api-key` 请求头进行鉴权。支持两种模式：

### 模式一：自部署（API Key）

在 rdCLI 网页界面生成一个 API Key（`ck_` 开头），调用时附加到请求头：

```http
x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

该 Key 与创建它的用户绑定，所有操作以该用户的身份执行。

### 模式二：Platform 模式

当 rdCLI 以 `VITE_IS_PLATFORM=true` 启动时，认证由外部代理处理，API 请求无需提供 Key，系统自动使用数据库中的首个用户。

---

## 统一响应格式

API 1（异步核稿）与 API 2（会话跳转）的所有接口，以及异步核稿的**回调推送**，均使用同一套 JSON 信封（envelope）结构：

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:00",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": { }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | number | 业务状态码，`0` 表示成功，非 `0` 为错误（见下方错误码表） |
| `timestamp` | string | 服务器本地时间，`YYYY-MM-DD HH:MM:SS` |
| `message` | string | 状态描述，成功为 `"success"`，失败为具体错误信息 |
| `task_id` | string \| null | 任务 ID（UUID）。有任务时为 UUID；错误响应或无任务的操作（如会话跳转）为 `null` 或省略 |
| `data` | object \| array | 业务数据；错误时为 `{}` |

> 提交任务、查询任务、撤销任务等**接口返回**与核稿完成后的**回调推送**结构完全一致，调用方可用同一套解析逻辑处理。

### 错误码表

| `code` | HTTP 状态码 | 含义 |
|:---:|:---:|------|
| `0` | 200 | 成功 |
| `1001` | 400 | 未上传文件 |
| `1002` | 400 | 文件格式不支持（仅支持 .docx） |
| `1003` | 400 | 文件超过 20MB 上限 |
| `1004` | 400 | （已废弃，`callback_url` 不再必填） |
| `1005` | 400 | `callback_url` 格式非法（必须以 `http://` 或 `https://` 开头） |
| `1006` | 429 | 同时处理的核稿任务已达上限（5 个） |
| `1007` | 400 | 缺少 `?id=<taskId>` 参数 |
| `1008` | 404 | 任务不存在 |
| `1009` | 401 | 认证失败（缺少或无效的 API Key） |
| `1010` | 500 | 服务端错误（如撤销失败） |
| `2001` | 200 | 回调专用：核稿执行失败（`data.status = "failed"`） |
| `2002` | 200 | 回调专用：任务已撤销（`data.status = "cancelled"`） |

---

## API 1：文档核稿（异步回调）

提交 .docx 文档并（可选）提供一个回调地址，创建异步核稿任务。任务在后台由 Claude 处理，完成后可主动调用回调地址，把 Markdown 格式的核稿意见推送给调用方；若未提供回调地址，调用方可通过查询接口轮询获取结果。

> 推荐用于 OA 系统集成等全自动场景（也可不传 `callback_url`，通过轮询获取结果）。如果需要人工复核和追问，请使用 [API 2：文档核稿（会话跳转）](#api-2文档核稿会话跳转)。

### 整体流程

```
OA 系统                                          rdCLI
   │                                               │
   │  POST /api/proofread                          │
   │  file: <docx>                                 │
   │  callback_url: https://oa.example.com/...     │
   │──────────────────────────────────────────────►│  立即返回 taskId
   │                                               │
   │  { code:0, timestamp:"...", message:"success",│
   │    task_id:"550e8400-...",                    │
   │    data: { status: "pending" } }              │
   │◄──────────────────────────────────────────────│
   │                                               │  Claude 后台核稿...
   │                                               │
   │  POST https://oa.example.com/proofread/cb      │  ← 核稿完成，回调推送
   │  { code:0, timestamp:"...", message:"success",│
   │    task_id:"550e8400-...",                    │
   │    data: { status:"completed", ...            │
   │      result_text:"## 核稿结果\n\n### 1. ..."  }│
   │◄──────────────────────────────────────────────│
   │                                               │
   │  200 OK                                       │
   │──────────────────────────────────────────────►│
```

### POST /api/proofread — 提交任务

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `multipart/form-data` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**表单字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `file` | file | ✅ | Word 文档（.docx），最大 20MB |
| `callback_url` | string | | 核稿完成后回调的地址，`http://` 或 `https://` 均可。不传则通过查询接口获取结果 |
| `additional_instructions` | string | | 追加的核稿要求，例如"重点检查数据引用"、"只看格式问题" |

**响应（200）：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:00",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "pending"
  }
}
```

| 字段 | 说明 |
|------|------|
| `task_id` | 任务 ID，UUID 全局唯一，用于后续查询或撤销 |
| `data.status` | 初始状态固定为 `"pending"` |

**错误响应（400）：**

```json
{
  "code": 1005,
  "timestamp": "2026-10-22 18:00:01",
  "message": "callback_url 格式不合法，必须以 http:// 或 https:// 开头",
  "task_id": null,
  "data": {}
}
```

| `code` | 含义 |
|:---:|------|
| 1001 | 未上传文件 |
| 1002 | 文件格式不支持（仅支持 .docx） |
| 1003 | 文件超过 20MB 上限 |
| 1005 | `callback_url` 格式非法（必须以 `http://` 或 `https://` 开头） |

**错误响应（429）：**

```json
{
  "code": 1006,
  "timestamp": "2026-10-22 18:00:01",
  "message": "同时处理的核稿任务已达上限（5 个），请等待已有任务完成后重试",
  "task_id": null,
  "data": {}
}
```

**错误响应（401）：**

```json
{
  "code": 1009,
  "timestamp": "2026-10-22 18:00:01",
  "message": "认证失败",
  "task_id": null,
  "data": {}
}
```

---

### 回调通知

任务到达终态（`completed` / `failed` / `cancelled`）后，rdCLI 会向提交时提供的 `callback_url` 发起 `POST` 请求，`Content-Type: application/json`，请求体为任务状态数据。

**回调请求体 — 已完成：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:02:30",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "completed",
    "file_name": "来文登记.docx",
    "file_size": 45678,
    "additional_instructions": "重点检查数据引用",
    "result_text": "## 核稿结果\n\n### 1. 错别字\n\n- **原文**：截至2025年12月底，全市生产总值达到120亿元。\n- **修改建议**：\"截至\"后缺少逗号，应为\"截至 2025 年 12 月底\"。\n- **修改理由**：数字与中文之间应留空格，保持全文格式统一。\n\n### 2. 数据问题\n\n- **原文**：较上年增长8.5%。\n- **修改建议**：请核实增长率 8.5% 是否准确，前文提到基数为 110 亿，推算增长约为 9.1%。\n- **修改理由**：数据前后不一致，需核实后修正。\n\n### 3. 标点符号\n\n...",
    "tokens": {
      "inputTokens": 3840,
      "outputTokens": 1250,
      "totalTokens": 5090
    },
    "session_id": "550e8400-e29b-41d4-a716-446655440002",
    "session_url": "https://rdcli.example.com/chat?session=550e8400-e29b-41d4-a716-446655440002",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:02:30"
  }
}
```

**回调请求体 — 失败：**

```json
{
  "code": 2001,
  "timestamp": "2026-10-22 18:00:15",
  "message": "Claude is not installed. Please install it first.",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "failed",
    "file_name": "来文登记.docx",
    "error_message": "Claude is not installed. Please install it first.",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:00:15"
  }
}
```

**回调请求体 — 已撤销：**

```json
{
  "code": 2002,
  "timestamp": "2026-10-22 18:01:30",
  "message": "任务已撤销",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "cancelled",
    "file_name": "来文登记.docx",
    "error_message": "任务已撤销",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:01:30"
  }
}
```

| 字段 | 说明 |
|------|------|
| `code` | 业务码：`0` 成功，`2001` 失败，`2002` 已撤销 |
| `timestamp` | 服务器本地时间 |
| `message` | 成功为 `"success"`，失败为 `error_message` 内容 |
| `task_id` | 任务 ID，与提交时返回的一致 |
| `data.status` | 终态：`"completed"`、`"failed"`、`"cancelled"` |
| `data.result_text` | **核稿意见全文，Markdown 格式**（仅 `completed`） |
| `data.tokens` | Token 消耗统计（仅 `completed`） |
| `data.session_id` / `data.session_url` | 关联聊天会话，可用于人工复核（仅 `completed`） |
| `data.error_message` | 失败或撤销原因（仅 `failed` / `cancelled`） |
| `data.created_at` / `data.updated_at` | 创建/更新时间，`YYYY-MM-DD HH:MM:SS` |

**回调约定：**

- 仅当提交时提供了 `callback_url` 才会触发回调推送
- rdCLI 回调你的地址后，**必须返回 `2xx` 状态码**，否则视为回调失败
- 回调失败会重试，最多 **3 次**，间隔递增；重试仍失败则放弃
- `callback_url` 支持 `http://` 和 `https://`；使用 `https://` 时**忽略证书校验**（自签名证书可直接使用）
- 未提供 `callback_url` 时，可通过 `GET /api/proofread/task?id=<taskId>` 轮询查询结果

### 任务状态流转

```
pending ──→ processing ──→ completed
          │    │                │
          └────┼──→ cancelled   │
               │                │
               └──→ failed      │
                                │
                (pending 也可取消)
```

| 状态 | 含义 |
|------|------|
| `pending` | 已提交，等待处理 |
| `processing` | Claude 正在核稿中 |
| `completed` | 核稿完成，`result_text` 字段有内容 |
| `failed` | 核稿失败，`error_message` 字段有错误原因 |
| `cancelled` | 已撤销，`error_message` 字段有撤销说明 |

以上任一状态到达终态（`completed` / `failed` / `cancelled`）后，如果提交时提供了 `callback_url`，都会触发一次回调推送。

### 并发限制

同一用户**同时处理中的核稿任务不超过 5 个**。超过上限后提交新任务会立即返回 `429` 错误（错误码 `1006`），需等待已有任务完成。

---

### GET /api/proofread/task — 查询任务

支持两种用法：

- `GET /api/proofread/task` — 返回当前用户所有**未完成**（pending + processing）的核稿任务，按创建时间倒序
- `GET /api/proofread/task?id=<taskId>` — 查询单个任务状态或结果（例如回调丢失后兜底排查）

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `GET` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

#### 任务列表 — 响应（200）

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:05",
  "message": "success",
  "task_id": null,
  "data": {
    "tasks": [
      {
        "task_id": "550e8400-e29b-41d4-a716-446655440000",
        "status": "processing",
        "file_name": "来文登记.docx",
        "file_size": 45678,
        "additional_instructions": "重点检查数据引用",
        "created_at": "2026-10-22 18:00:00",
        "updated_at": "2026-10-22 18:00:05"
      },
      {
        "task_id": "660e8400-e29b-41d4-a716-446655440001",
        "status": "pending",
        "file_name": "通知.docx",
        "file_size": 12345,
        "created_at": "2026-10-22 17:55:00",
        "updated_at": "2026-10-22 17:55:00"
      }
    ]
  }
}
```

**调用示例：**

```bash
curl -X GET "https://rdcli.example.com/api/proofread/task" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 空列表：
# { "code": 0, "timestamp": "...", "message": "success", "task_id": null, "data": { "tasks": [] } }
```

#### 查询单个任务

`GET /api/proofread/task?id=<taskId>`

**响应 — 排队中（200）：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:00",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "pending",
    "file_name": "来文登记.docx",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:00:00"
  }
}
```

**响应 — 处理中（200）：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:05",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "processing",
    "file_name": "来文登记.docx",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:00:05"
  }
}
```

**响应 — 已完成（200）：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:02:30",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "completed",
    "file_name": "来文登记.docx",
    "file_size": 45678,
    "additional_instructions": "重点检查数据引用",
    "result_text": "## 核稿结果\n\n### 1. 错别字\n\n- **原文**：截至2025年12月底，全市生产总值达到120亿元。\n- **修改建议**：\"截至\"后缺少逗号，应为\"截至 2025 年 12 月底\"。\n- **修改理由**：数字与中文之间应留空格，保持全文格式统一。\n\n### 2. 数据问题\n\n- **原文**：较上年增长8.5%。\n- **修改建议**：请核实增长率 8.5% 是否准确，前文提到基数为 110 亿，推算增长约为 9.1%。\n- **修改理由**：数据前后不一致，需核实后修正。\n\n### 3. 标点符号\n\n...",
    "tokens": {
      "inputTokens": 3840,
      "outputTokens": 1250,
      "totalTokens": 5090
    },
    "session_id": "550e8400-e29b-41d4-a716-446655440002",
    "session_url": "https://rdcli.example.com/chat?session=550e8400-e29b-41d4-a716-446655440002",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:02:30"
  }
}
```

| 字段 | 说明 |
|------|------|
| `data.result_text` | **核稿意见全文，Markdown 格式**。Claude 按核稿标准逐项审查后输出 |
| `data.tokens` | Token 消耗统计 |
| `data.session_id` / `data.session_url` | 关联的聊天会话，可用于人工复核 |

**响应 — 失败（200）：**

```json
{
  "code": 2001,
  "timestamp": "2026-10-22 18:00:15",
  "message": "Claude is not installed. Please install it first.",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "failed",
    "file_name": "来文登记.docx",
    "error_message": "Claude is not installed. Please install it first.",
    "created_at": "2026-10-22 18:00:00",
    "updated_at": "2026-10-22 18:00:15"
  }
}
```

**响应 — 任务不存在（404）：**

```json
{
  "code": 1008,
  "timestamp": "2026-10-22 18:05:00",
  "message": "任务不存在",
  "task_id": null,
  "data": {}
}
```

**调用示例：**

```bash
curl -X GET "https://rdcli.example.com/api/proofread/task?id=550e8400-e29b-41d4-a716-446655440000" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

---

### GET /api/proofread — 用法说明

无需鉴权，返回核稿任务的提交用法示例。

**响应（200）：**

```json
{
  "message": "请使用 POST 方法提交核稿任务",
  "example": {
    "curl": "curl -X POST <rdcli-host>/api/proofread \\\n  -H \"x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" \\\n  -F \"file=@文档.docx\" \\\n  -F \"callback_url=https://oa.example.com/api/callback\" \\\n  -F \"additional_instructions=重点检查数据引用\"",
    "fields": {
      "file": "(必填) Word 文档 .docx，最大 20MB",
      "callback_url": "(可选) 核稿完成后回调地址，http:// 或 https://，不传则通过 GET /api/proofread/task?id=xxx 轮询结果",
      "additional_instructions": "(可选) 追加核稿要求"
    }
  },
  "links": {
    "task_list": "GET /api/proofread/task — 查看进行中的任务",
    "query_task": "GET /api/proofread/task?id=<taskId> — 查询单个任务状态",
    "cancel_task": "DELETE /api/proofread/task?id=<taskId> — 撤销任务",
    "session_mode": "POST /api/proofread/session — 创建会话跳转"
  }
}
```

---

### DELETE /api/proofread/task — 撤销任务

`DELETE /api/proofread/task?id=<taskId>`

撤销一个等待中或处理中的核稿任务。如果任务正在运行，将强制中断底层的 Claude 会话。

> ⚠️ 已完成（completed）或已失败（failed）的任务不能撤销，会返回 404。

**请求：**

| 项目 | 说明 |
|------|------|
| **Method** | `DELETE` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |
| **Query** | `id=<taskId>`（必需） |

**响应（200）：**

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:01:30",
  "message": "success",
  "task_id": "550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "status": "cancelled",
    "updated_at": "2026-10-22 18:01:30"
  }
}
```

**响应 — 缺少 id 参数（400）：**

```json
{
  "code": 1007,
  "timestamp": "2026-10-22 18:01:30",
  "message": "请提供 ?id=<taskId> 参数",
  "task_id": null,
  "data": {}
}
```

**响应 — 失败（404）：**

```json
{
  "code": 1008,
  "timestamp": "2026-10-22 18:01:30",
  "message": "任务不存在或已完成，无法撤销",
  "task_id": null,
  "data": {}
}
```

**调用示例：**

```bash
curl -X DELETE "https://rdcli.example.com/api/proofread/task?id=550e8400-e29b-41d4-a716-446655440000" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 响应：
# { "code": 0, "timestamp":"...", "message": "success", "task_id": "550e8400...", "data": { "status": "cancelled", "updated_at": "..." } }
```

---

### 调用示例

```bash
# Step 1：提交任务（附带回调地址）
curl -X POST https://rdcli.example.com/api/proofread \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "file=@来文登记.docx" \
  -F "callback_url=https://oa.example.com/api/proofread/callback" \
  -F "additional_instructions=重点检查涉及财政数据的表述"

# 响应：
# { "code": 0, "timestamp":"...", "message": "success", "task_id": "550e8400...", "data": { "status": "pending" } }

# Step 2：等待回调（或轮询）。核稿完成后，rdCLI 会 POST 到你的 callback_url，
# 请求体即核稿结果（见上方「回调通知」一节）。
# 如果不传 callback_url，可通过轮询获取结果：
# curl -X GET "https://rdcli.example.com/api/proofread/task?id=550e8400..." \
#   -H "x-api-key: ck_xxxx"

# Step 3(optional)：如需撤销一个处理中的任务
curl -X DELETE "https://rdcli.example.com/api/proofread/task?id=550e8400-e29b-41d4-a716-446655440000" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# 响应：
# { "code": 0, "timestamp":"...", "message": "success", "task_id": "550e8400...", "data": { "status": "cancelled", "updated_at": "..." } }
```

### OA 系统集成示例（Node.js）

```javascript
// ── 1. 提交任务（OA 后端） ──────────────────────────────────────────
async function submitProofread(fileBuffer, fileName, instructions = '') {
  const form = new FormData();
  form.append('file', fileBuffer, fileName);
  form.append('callback_url', 'https://oa.example.com/api/proofread/callback');
  if (instructions) {
    form.append('additional_instructions', instructions);
  }

  const res = await fetch('https://rdcli.example.com/api/proofread', {
    method: 'POST',
    headers: { 'x-api-key': process.env.RDCLI_API_KEY },
    body: form
  });
  const { task_id, data } = await res.json();
  return task_id; // 拿到 taskId，等待回调即可
}

// ── 2. 接收回调（OA 后端暴露的 Webhook 端点） ──────────────────────
app.post('/api/proofread/callback', (req, res) => {
  // 立即返回 2xx，避免 rdCLI 判定回调失败而重试
  res.status(200).json({ received: true });

  const { task_id, data } = req.body;
  const { status, result_text, error_message } = data;

  if (status === 'completed') {
    // 保存并展示核稿意见（Markdown）
    saveResult(task_id, result_text);
  } else if (status === 'failed') {
    // 记录失败原因，通知用户
    logFailure(task_id, error_message);
  } else if (status === 'cancelled') {
    // 任务被撤销
    logCancelled(task_id);
  }
});
```

---


## API 2：文档核稿（会话跳转）

上传 .docx 文档，创建一个预填充的核稿会话。Claude 在后台开始核稿，**立即返回会话链接**，用户打开链接后在聊天界面查看核稿结果并可以继续追问。

> 适合需要人工复核、追加指令的场景。如果不需要交互，直接要结果，用 [API 1：文档核稿（异步回调）](#api-1文档核稿异步回调)。

### 端点

```
POST /api/proofread/session
```

### 请求

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `multipart/form-data` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**表单字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `file` | file | ✅ | Word 文档（.docx），最大 20MB |
| `additional_instructions` | string | | 追加的核稿要求，例如"重点检查数据引用"、"只看格式问题" |

### 响应

#### 200 — 成功

```json
{
  "code": 0,
  "timestamp": "2026-10-22 18:00:00",
  "message": "success",
  "task_id": null,
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440002",
    "session_url": "https://rdcli.example.com/chat?session=550e8400-e29b-41d4-a716-446655440002"
  }
}
```

| 字段 | 说明 |
|------|------|
| `data.session_id` | Claude 会话 ID |
| `data.session_url` | 打开后进入聊天界面查看核稿结果，可继续追问 |

#### 400 — 请求错误

```json
{
  "code": 1002,
  "timestamp": "2026-10-22 18:00:00",
  "message": "仅支持 .docx 格式的 Word 文档",
  "task_id": null,
  "data": {}
}
```

| `code` | 含义 |
|:---:|------|
| 1001 | 未上传文件 |
| 1002 | 文件格式不支持（仅支持 .docx） |
| 1003 | 文件超过 20MB 上限 |

#### 401 — 鉴权失败

```json
{
  "code": 1009,
  "timestamp": "2026-10-22 18:00:00",
  "message": "认证失败",
  "task_id": null,
  "data": {}
}
```

### 调用示例

```bash
curl -X POST https://rdcli.example.com/api/proofread/session \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -F "file=@来文登记.docx" \
  -F "additional_instructions=请重点检查涉及财政数据的表述"

# 响应：
# {
#   "code": 0,
#   "timestamp": "...",
#   "message": "success",
#   "task_id": null,
#   "data": {
#     "session_id": "550e8400-e29b-41d4-a716-446655440002",
#     "session_url": "https://rdcli.example.com/chat?session=550e8400-e29b-41d4-a716-446655440002"
#   }
# }
```

---

## API 3：通用 Agent

触发 Claude 在指定代码仓库上执行任务。支持克隆 GitHub 仓库、可选的 Git 分支和 PR 创建。

### 端点

```
POST /api/agent
```

### 请求

| 项目 | 说明 |
|------|------|
| **Method** | `POST` |
| **Content-Type** | `application/json` |
| **鉴权** | `x-api-key: ck_xxxx`（必需，Platform 模式除外） |

**请求体参数：**

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|:---:|------|------|
| `message` | string | ✅ | | 任务描述，告诉 Claude 要做什么 |
| `githubUrl` | string | 条件 | | GitHub 仓库 URL（HTTPS 或 SSH），与 `projectPath` 二选一 |
| `projectPath` | string | 条件 | | 本地项目路径，与 `githubUrl` 二选一 |
| `provider` | string | | `"claude"` | AI 提供商，目前仅支持 `"claude"` |
| `model` | string | | 默认模型 | `"default"`、`"sonnet"`、`"opus"`、`"haiku"`、`"fable"` |
| `effort` | string | | | 推理深度：`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"` |
| `stream` | boolean | | `true` | `true`=SSE 流式返回，`false`=等待完成后返回 JSON |
| `cleanup` | boolean | | `true` | 完成后是否删除临时克隆的仓库（仅对 githubUrl 生效） |
| `sessionId` | string | | | 指定已有的会话 ID（用于恢复已有会话） |
| `githubToken` | string | | | GitHub Token，覆盖用户设置中存储的 Token |
| `branchName` | string | | | 自定义 Git 分支名，提供后自动启用 createBranch |
| `createBranch` | boolean | | `false` | 任务完成后创建 Git 分支并推送到远程 |
| `createPR` | boolean | | `false` | 任务完成后创建 GitHub Pull Request |

### 路径行为

| 场景 | 输入 | 行为 |
|------|------|------|
| 仅 githubUrl | `githubUrl: "https://github.com/o/r"` | 克隆到 `~/.claude/external-projects/<hash>/`，cleanup 后删除 |
| 仅 projectPath | `projectPath: "/home/user/project"` | 使用已有项目，不清理 |
| 两者都有 | `githubUrl` + `projectPath` | 克隆到指定路径；如路径已存在且 remote 匹配则复用 |

### 响应

#### stream=false（非流式）

```json
{
  "success": true,
  "sessionId": "abc123-def456",
  "messages": [
    {
      "type": "assistant",
      "message": {
        "role": "assistant",
        "content": [{"type": "text", "text": "已完成..."}]
      }
    }
  ],
  "tokens": {
    "inputTokens": 1500,
    "outputTokens": 800,
    "cacheReadTokens": 0,
    "cacheCreationTokens": 0,
    "totalTokens": 2300
  },
  "projectPath": "/home/user/.claude/external-projects/abc123",
  "branch": {
    "name": "fix-bug-lx9abc",
    "url": "https://github.com/owner/repo/tree/fix-bug-lx9abc"
  },
  "pullRequest": {
    "number": 42,
    "url": "https://github.com/owner/repo/pull/42"
  }
}
```

- `branch` 和 `pullRequest` 仅在 `createBranch` / `createPR` 为 true 时出现
- 如果分支/PR 创建失败，对应字段为 `{ "error": "错误描述" }`

#### stream=true（SSE 流式）

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

SSE 事件类型：

| 事件类型 | 说明 |
|----------|------|
| `status` | 状态更新，含 `message` 和 `projectPath` |
| `claude-response` | Claude 的实时输出，`data` 字段为 SDK 消息 |
| `github-branch` | 分支创建成功，含 `branch.name` 和 `branch.url` |
| `github-pr` | PR 创建成功，含 `pullRequest.number` 和 `pullRequest.url` |
| `github-error` | GitHub 操作失败（不影响 Claude 任务本身） |
| `error` | 任务失败的错误信息 |
| `done` | 流结束标记 |

#### 400 — 请求错误

| 错误信息 | 说明 |
|----------|------|
| `Either githubUrl or projectPath is required` | 两个参数都未提供 |
| `message is required` | 未提供任务描述 |
| `provider must be "claude"` | 不支持的 provider |
| `createBranch and createPR require either githubUrl or projectPath with a GitHub remote` | 缺少 GitHub 仓库信息 |

#### 401 — 鉴权失败

```json
{ "error": "API key required" }
```
```json
{ "error": "Invalid or inactive API key" }
```

#### 500 — 服务端错误

```json
{ "success": false, "error": "具体错误描述" }
```

### SSE 流读取示例

```javascript
const response = await fetch('https://rdcli.example.com/api/agent', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': 'ck_xxxx'
  },
  body: JSON.stringify({
    message: '修复所有 TypeScript 类型错误',
    githubUrl: 'https://github.com/owner/repo',
    createPR: true,
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      console.log(data.type, data);
    }
  }
}
```

### 调用示例

```bash
# 克隆仓库并创建 PR（非流式）
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "将所有的 var 声明改为 const/let，并修复 ESLint 报错",
    "githubUrl": "https://github.com/owner/my-project",
    "createPR": true,
    "stream": false
  }'

# 使用已有项目，指定模型（流式）
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "给 UserService 添加单元测试",
    "projectPath": "/home/dev/backend-service",
    "model": "sonnet",
    "stream": true
  }'

# 指定自定义分支名和 PR
curl -X POST https://rdcli.example.com/api/agent \
  -H "Content-Type: application/json" \
  -H "x-api-key: ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -d '{
    "message": "Refactor database layer to use connection pooling",
    "projectPath": "/home/dev/api-server",
    "branchName": "refactor/db-connection-pool",
    "createPR": true,
    "stream": true
  }'
```

---

## 获取 API Key

1. 登录 rdCLI 网页界面
2. 进入 **设置** → **API Keys**
3. 点击 **创建 API Key**，输入名称（如 "oa-system"）
4. 复制生成的 Key（`ck_` 开头），**仅显示一次**
5. 外部程序调用时通过 `x-api-key` 请求头传入

---

## 附录

### 核稿标准说明

核稿不注入自定义 System Prompt。校对标准完全定义在容器的全局 CLAUDE.md 中（`deploy/CLAUDE.md`），Claude 启动时自动加载。

**两套标准：**

- **通用文稿校对**：错别字、标点符号、语法、逻辑矛盾、表达冗余、数字日期名称一致性、标题层级
- **党政机关公文核稿**（GB/T 9704-2012）：文种、标题格式、发文字号、主送机关、正文结构、附件说明、落款、专用语、敏感信息

Claude 根据文档内容自行判断适用标准。核稿输出格式：每条问题包含 **原文**、**修改建议**、**修改理由**。

### 异步核稿 vs 会话跳转 对比

| | API 1：异步回调 | API 2：会话跳转 |
|---|---|---|
| 端点 | `POST /api/proofread` + `GET /api/proofread/task?id=<taskId>` | `POST /api/proofread/session` |
| 返回方式 | 先返回 taskId，完成后主动回调 | 立即返回 session_url |
| 结果格式 | 回调推送 Markdown 文本 (`result_text`) | 聊天界面 Claude 回复 |
| 人工交互 | 不支持 | 支持追问、追加指令 |
| 适用场景 | 全自动批量核稿，OA 集成 | 人工复核 |
| 超时风险 | 无（异步回调） | 无（会话持续有效） |

### Agent API 分支命名规则

当 `createBranch=true` 且未提供 `branchName` 时，分支名由 message 自动生成：

- 英文/数字/连字符保留，特殊字符移除
- 空格转连字符
- 末尾追加 6 位时间戳后缀
- 总长度不超过 50 字符

### 限制说明

| 项目 | 限制 |
|------|------|
| 核稿文件格式 | 仅 `.docx` |
| 核稿文件大小 | 最大 20MB |
| Agent provider | 仅 `claude` |
| 核稿超时 | 无显式上限（异步回调模式无连接超时问题） |
| Agent 超时 | 无显式上限，由 Claude SDK stream timeout（300 秒空闲）控制 |
| PR 目标分支 | 固定为 `main` |
| cleanup | 仅对 `githubUrl` 克隆的临时项目生效，已有 `projectPath` 不会被清理 |

### 速率限制

所有 `/api` 路径受通用速率限制器保护（`generalApiLimiter`），认证路由另有严格限制（`strictAuthLimiter`）。
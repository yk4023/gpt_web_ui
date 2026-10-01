# Codex Claude Gateway

把符合条件的 ChatGPT/Codex 套餐推理能力通过本地 **Anthropic Messages 和 OpenAI Chat Completions** 接口提供给 Claude Code 等应用：使用一个账号完成授权和调用，无需为这些符合条件的请求另买 OpenAI API 额度。项目提供模型别名、本地 API Key、每日请求和 token 限额、并发限制及使用记录；服务将客户端请求转换为 OpenAI Responses API 请求。

> 这是社区项目，与 OpenAI、Anthropic 无隶属关系。

## 快速安装（Windows PowerShell）

**1. 准备环境并启动。** 安装 Node.js 24.5+ 或 22.21+；本项目无需执行 `npm install`。在 PowerShell 中运行：

```powershell
git clone https://github.com/yk4023/gpt_web_ui.git
cd gpt_web_ui
npm start
```

**2. 打开管理页。** 浏览器访问 `http://127.0.0.1:8765`。首次启动会生成管理员令牌；另开一个 PowerShell 窗口，在项目目录运行下面的命令，复制结果并登录：

```powershell
Get-Content '.data/admin-token'
```

**3. 连接账号并创建网关密钥。** 在管理页依次操作：

1. 点击“使用 ChatGPT 登录”完成独立授权。
2. 点击“查询可用模型”，在“模型映射”中设置客户端别名，从下拉列表选择上游模型 ID，然后保存。
3. 创建网关 API Key，设置限额，并立即保存完整的 `cg_...` 密钥；页面只显示一次。

**4. 接入客户端。** 在“客户端接入”中填入网关密钥和模型，复制 Claude Code 或 OpenAI 格式配置。两个接口共用同一套模型映射和网关密钥：

| 客户端格式 | Base URL | API Key |
| --- | --- | --- |
| Claude Code / Anthropic Messages | `http://127.0.0.1:8765` | 管理页生成的 `cg_...` |
| OpenAI Chat Completions | `http://127.0.0.1:8765/v1` | 同一枚 `cg_...` |

模型填写“模型映射”中保存的**客户端别名**，不要填写上游模型 ID。默认映射仅是示例，需按账号实际可用模型调整。

## 可选：使用 OpenAI API Key 或本机代理

如果不用 ChatGPT 套餐授权，可在**启动网关的终端**先设置 `OPENAI_API_KEY`，然后运行 `npm start`。这种模式按 OpenAI API 计费；客户端仍只使用网关生成的 `cg_...` 密钥。设置该环境变量后，网关会优先使用它。

```powershell
$env:OPENAI_API_KEY = '<你的 OpenAI API Key>'
npm start
```

本机需要通过代理访问上游时，可复制 [`config/network.example.json`](config/network.example.json) 到 `.data/network.json` 并修改地址，或在启动前设置 `GATEWAY_PROXY_URL`（环境变量优先）。代理只接受本机 HTTP/HTTPS 地址；授权、模型查询和推理会使用它。代理不会改变 OpenAI 服务地区要求。

```powershell
New-Item -ItemType Directory -Force .data | Out-Null
Copy-Item config/network.example.json .data/network.json
```

## 配置示例

Claude Code `settings.json` 示例（推荐直接复制管理页生成的配置）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<管理页生成的 cg_... 密钥>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "codex-luna",
    "CLAUDE_CODE_SUBAGENT_MODEL": "codex-luna",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "983616"
  }
}
```

`codex-luna` 必须先在模型映射中保存；`983616` 是可编辑的客户端配置值，不能扩大上游模型的实际上下文容量。如果 `settings.json` 已有其他配置，请将生成的 `env` 字段合并到现有 JSON 对象中。

也可以选择 PowerShell 格式：

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8765'
$env:ANTHROPIC_AUTH_TOKEN = '<管理页生成的 cg_... 密钥>'
$env:ANTHROPIC_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'codex-sol'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'codex-sol'
claude
```

OpenAI 兼容客户端使用同一枚网关 `cg_...` 密钥，Base URL 填 **`http://127.0.0.1:8765/v1`**，模型填写管理页保存的客户端别名。管理页“OpenAI 格式接入”可直接复制这组配置。例如在 PowerShell 中：

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:8765/v1'
$env:OPENAI_API_KEY = '<管理页生成的 cg_... 密钥>'
$env:OPENAI_MODEL = 'codex-luna'
```

OpenAI 兼容范围目前是 Chat Completions 的文本、图片输入、函数工具、流式输出及模型列表；其他 OpenAI 专有接口或参数并未实现。

## 使用边界

- 网关**不会读取或控制 Codex 桌面窗口**。它通过独立的 Sign in with ChatGPT 授权调用符合条件的 OpenAI Responses API 请求。套餐资格、模型权限和共享额度仍由 OpenAI 决定；网关不会生成额外额度。
- 管理页显示的剩余请求数、Token 数以及日/周/月图表是**本地网关统计**，不代表 ChatGPT 账号的真实余额。账号用量请到 [ChatGPT 官方用量页](https://chatgpt.com/settings/usage)查看。每日 Token 限额在响应完成后累计，边界处可能多出一次请求。
- 图表保存约 400 天的每日汇总，按 `GATEWAY_TIMEZONE`（默认 `Asia/Shanghai`）划分日期。旧版本升级当天可继承密钥累计总数，更早的历史无法补齐。
- Claude Code 对非 Claude 模型网关没有官方兼容承诺。项目覆盖常见文本、图片输入、工具调用和流式输出；请先用小任务验证所用客户端版本。

## 接口与数据

| 接口 | 用途 |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages 文本、图片输入、函数工具及 SSE 响应 |
| `POST /v1/chat/completions` | OpenAI Chat Completions 文本、图片输入、函数工具及 SSE 响应 |
| `POST /v1/messages/count_tokens` | 本地字符估算；不代表上游精确计费 |
| `GET /v1/models` | 当前网关密钥允许的模型别名，OpenAI 风格列表 |
| `GET /health` | 运行状态 |
| `/admin/api/*` | 管理页调用，需 `X-Admin-Token` |

管理页可创建与吊销密钥、修改模型映射、查看日志和切换已授权的 ChatGPT 账号。密钥只保存 SHA-256 摘要；管理员令牌、用量数据、OAuth 凭据保存在 `.data/`，该目录已加入 `.gitignore`。不要公开 `.data/`，也不要把本地端口直接暴露到公网。

## 授权失败排查

如果回调页显示 `HTTP 403 (unsupported_country_region_territory)`，OpenAI 拒绝了当前网络出口地区的令牌请求。这是上游地区限制，重新使用同一个回调链接或授权码不会解决；请核对 [OpenAI API 支持地区](https://developers.openai.com/api/docs/supported-countries) 和实际网络出口。其他错误请保留页面显示的错误码和 request ID 排查，不要分享回调 URL 中的一次性授权码。

## 测试

```powershell
npm test
node scripts/claude-smoke.mjs
```

测试使用本地模拟上游，覆盖 Messages 转换、工具调用流式事件、配额、管理员创建密钥、OAuth 令牌校验与刷新。第二条命令还会调用本机已安装的 Claude Code CLI，检查一次读取文件的工具调用与结果回传；不使用 OpenAI/ChatGPT 额度。真实账号推理仍需完成登录后验证。

提交改进前请阅读[贡献指南](CONTRIBUTING.md)。

## 设计依据

- [OpenAI：Sign in with ChatGPT 快速入门](https://developers.openai.com/siwc/quickstart)
- [OpenAI：本地应用的注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI：模型与 Responses API 推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI：预览阶段限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Claude Code：网关兼容格式](https://code.claude.com/docs/en/llm-gateway-protocol)

## 许可证

[MIT](LICENSE)

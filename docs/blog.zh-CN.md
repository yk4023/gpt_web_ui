# 把 Codex 套餐能力变成本地 API：一个 ChatGPT 账号供 Claude Code 等应用使用

> 项目地址：[Codex Claude Gateway · GitHub](https://github.com/yk4023/gpt_web_ui)
>
> 关键词：Claude Code、OpenAI、Anthropic Messages、本地网关、模型映射

## 前言：已经有 Codex 套餐，为什么还要再买一份 API 额度？

这就是我做这个项目的直接原因：**我已经在使用 ChatGPT/Codex 套餐，希望让 Claude Code 和其他本地应用也能调用该套餐允许使用的模型，而不必为了同一类本地 AI 请求再单独配置 OpenAI API Key、购买 API 额度或另一份模型调用套餐。** 一个账号，在符合 OpenAI 资格、授权和额度规则时，供多个本地工具使用。

为此我做了 **Codex Claude Gateway**：通过 OpenAI 的 **Sign in with ChatGPT** 给本地网关独立授权，再把授权范围内的 Responses API 推理能力，以 **Anthropic Messages 和 OpenAI Chat Completions** 两种格式提供给其他本地应用。客户端只需填写对应 Base URL 和网关生成的密钥。OpenAI 官方明确允许符合条件的开源应用使用用户的 ChatGPT 套餐完成符合条件的请求，无需用户另行提供 API Key；这也是本项目采用的接入方式。详见 [OpenAI 官方快速入门](https://developers.openai.com/siwc/quickstart)。

这里的“映射”指**把套餐授权可用的推理能力通过本地 API 提供给其他应用**，并非读取或控制 Codex 桌面窗口，也不是把账号额度转卖、转移或变成一份独立的新额度。

举个直白的例子：你已经有符合条件的 ChatGPT 套餐，在本机运行网关并完成授权后，Claude Code 可以把请求发往 `http://127.0.0.1:8765`，由网关使用该账号被允许调用的模型响应。你不需要再给 Claude Code 填一枚单独购买的 OpenAI API Key；多个本地客户端也可以各用自己的网关密钥，方便分别限额和查看用量。

如果这个项目对你有帮助，欢迎到 [GitHub 仓库点个 Star ⭐](https://github.com/yk4023/gpt_web_ui)。Star 是我继续完善协议兼容和管理界面的动力。

## 它能做什么？

| 能力 | 实际用途 |
| --- | --- |
| 多模型映射 | 给不同上游模型设置客户端别名与可选思考等级，主模型、Haiku、Sonnet、Opus 和子代理可分别选择 |
| 本地 API Key | 为不同应用生成独立密钥，支持吊销和重新启用 |
| 网关限额 | 为密钥设置每日请求数、Token 数和并发上限 |
| 使用趋势 | 按小时、日、周、月查看本地请求数与 Token 消耗图表 |
| 套餐参考 | 手动选择 Plus、Pro 5×、Pro 20×、Business 等等级，查看官方公开的五小时消息数估算；实时余额仍到官方页面查看 |
| 配置生成 | 一键生成 Claude Code 的 `env` JSON 或 PowerShell 配置 |
| 双接口接入 | Claude Code 使用 Anthropic Messages；其他工具可使用 OpenAI Chat Completions 接口 |
| 上游连接 | 支持独立的 Sign in with ChatGPT 授权，或使用自己的 OpenAI API Key |

所有管理数据保存在本机。服务默认只监听 `127.0.0.1:8765`，不需要额外安装 npm 依赖。**如果你的 ChatGPT 账号不具备套餐推理资格，也可以使用自己的 OpenAI API Key，但这属于按 API 计费的备用模式。**

## 三步跑起来

**第一步：启动网关。** 准备 Node.js 24.5+ 或 22.21+，然后在 PowerShell 中运行：

```powershell
git clone https://github.com/yk4023/gpt_web_ui.git
cd gpt_web_ui
npm start
```

打开 `http://127.0.0.1:8765`。首次启动会在 `.data/admin-token` 生成管理员令牌，读取后登录管理页：

```powershell
Get-Content .data/admin-token
```

**第二步：连接套餐并配置模型。** 在页面点击“使用 ChatGPT 登录”，授权网关使用符合条件的 ChatGPT 套餐请求。接着查询当前账号可用模型，为客户端别名添加模型映射。上游模型 ID 可直接从查询结果的下拉列表选取，也可为每条映射选择思考等级。例如把 `codex-luna` 映射到账号实际可用的模型 ID。初始映射只是示例，请以查询结果为准。

**第三步：生成调用密钥并接入客户端。** 创建一枚 `cg_...` 网关密钥，在“客户端接入”选择模型。Claude Code 可复制页面生成的 `env JSON` 到 `settings.json`，也可以切换为 PowerShell 格式，在同一个终端启动 `claude`。OpenAI 格式客户端则复制同一页面的 OpenAI 配置。

两种格式使用**同一枚网关密钥**，但 Base URL 不同：

| 客户端 | Base URL | 模型填写什么 |
| --- | --- | --- |
| Claude Code / Anthropic Messages | `http://127.0.0.1:8765` | 保存的客户端别名 |
| OpenAI Chat Completions | `http://127.0.0.1:8765/v1` | 同一个客户端别名 |

配置的核心结构如下，密钥和模型名请以你自己的管理页为准：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<你的网关密钥>",
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

如果已有 `settings.json`，请把生成的 `env` 字段合并进去。上下文数值可以编辑，但它不会增加上游模型的真实容量。

其他支持 OpenAI Chat Completions 的应用可以直接使用下面这组参数，管理页也提供一键复制：

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:8765/v1'
$env:OPENAI_API_KEY = '<管理页生成的 cg_... 密钥>'
$env:OPENAI_MODEL = 'codex-luna'
```

这里的 OpenAI 兼容指 `/v1/chat/completions` 和 `/v1/models`，并非所有 OpenAI 专有接口。上面示例中的 `codex-luna` 需要先在模型映射中保存。

## 使用趋势到底统计了什么？

管理页可切换**近 14 日、12 周、12 月**，查看请求数或输入与输出 Token 消耗。每日汇总保存在本地，即使最近请求列表只保留 100 条，后续周、月图表仍可持续统计。

这里有个重要区别：**图表和“剩余额度”只统计经过本地网关的请求及你设置的网关限额，不是 ChatGPT 账号的官方余额。** 当前授权无法读取账号真实剩余额度，管理页提供了 ChatGPT 官方用量页入口。从旧版本升级时可接续当天已有总数，但之前未保存的历史无法补齐。

## 使用前的几个提醒

1. 这是社区项目，**不会读取或控制 Codex 桌面窗口**。它通过独立的 ChatGPT 套餐授权调用符合条件的 Responses API 请求；“一个账号解决”取决于你的套餐资格、所选模型和剩余额度，不能保证任意账号或任意请求都免费可用。
2. Claude Code 对非 Claude 模型网关没有官方兼容承诺。项目覆盖常用文本、图片输入、工具调用和流式事件，但未实现全部 Claude 专有能力。建议先用一个小任务验证自己的客户端版本。
3. 网关密钥、管理员令牌和授权回调链接都不要贴到 Issue、截图或公开仓库；`.data/` 目录也不要上传。服务不要直接暴露到公网。
4. 使用自己的 OpenAI API Key 时，调用按 OpenAI API 计费；使用 ChatGPT 套餐授权时，请求会计入该账号共享的套餐用量或适用额度，不会产生一份额外的额度。当前网络无法直连上游时，可在管理页填写受信任的本机 HTTP/HTTPS 代理并立即应用；代理只改变网络出口，不能保证通过 OpenAI 的地区校验，实际出口仍须符合服务要求。

## 写在最后

这个项目还在持续完善。代码、完整安装说明、测试方法和已知限制都放在 [GitHub 项目主页](https://github.com/yk4023/gpt_web_ui)。如果你想试用，欢迎 **Star ⭐ + Fork**；遇到兼容问题，也欢迎提交 Issue，附上去除密钥和个人信息后的复现步骤。

**项目地址：https://github.com/yk4023/gpt_web_ui**

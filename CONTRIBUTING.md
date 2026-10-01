# 贡献指南

欢迎提交问题报告和改进。请在提交前确认：

1. 描述复现步骤、预期与实际结果，并说明 Node.js 和 Claude Code 版本（如果相关）。
2. 不要在 Issue、日志或提交中放入 `.data/`、管理员令牌、网关密钥、OAuth 回调 URL、授权码或上游 API Key。
3. 修改代码后运行 `npm test`。涉及 Claude Code 协议兼容性的改动，可在已安装 CLI 的 Windows 环境运行 `node scripts/claude-smoke.mjs`。
4. 保持网关只监听回环地址。对上游权限、额度和模型可用性的描述，应以实际返回和官方文档为准。

项目通过 OpenAI Responses API 推理，不读取 Codex 桌面窗口或复用其登录态。请将功能建议建立在这个边界上。

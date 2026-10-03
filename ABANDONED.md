# ABANDONED

> **本项目已于 2026-10-03 停止开发并长期放弃。**
> 不再接受新功能、bug 修复或维护请求。

---

## 状态

- **开发状态**：已停止
- **维护状态**：无
- **最后更新**：2026-10-03
- **决定**：用户主动决定长期放弃，非技术故障导致

## 已实现的功能

本项目在放弃前已实现并验证了以下核心功能：

- 自管 Chromium 冷启动（离屏渲染 + CDP）
- 导航 / 读页 / 求值 / 截图
- CDP 实时画面推流（JPEG，可限帧）
- HTTP 面 `/status` `/stream`(SSE) `/command`
- 页面生命周期（多页 / 用完即收 / 超时回收 / 上限）
- 磁盘页面注册表 + 按需恢复
- 右侧 Sidebar 面板注册与视觉渲染
- `agent_browser` 工具（完整动作集）
- 现代风控通过率实测
- 显示一致性（screen/窗口/视口 + 帧覆盖面板盒）
- 真拖拽与命名键
- 输入自然化（`humanizeInput`）
- 可检测性（sannysoft 58 项 0 失败）
- 人机验证检测与提示
- 搜索引擎：预配置 + 实测 + 自主选择
- 标签条精简 + 左键菜单 + 状态配色 + forget
- 逐页休眠 / 唤醒
- 面板可自建标签页 / 多开
- 配色跟随 DSH（亮/暗自动同步）
- 页面自建的新标签接管
- 画面不会因"帧来早了"而空白
- 忙页不会把一次输入拖成几分钟
- 引擎是 Chromium（BSD-3）且被强制
- SSE 自动重连 + 面板自愈
- 下载捕获
- 登录态导入

## 文档

详细文档见：

- [README.md](README.md)：完整的功能、配置与使用说明
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：架构设计与扩展点
- [docs/ROADMAP.md](docs/ROADMAP.md)：原定的后续计划（已作废）
- [docs/CHALLENGE-ANALYSIS.md](docs/CHALLENGE-ANALYSIS.md)：现代风控逐行分析

## 代码

代码仓库保留在：

```
/var/home/felix/项目/dsh-agent-browser/
```

Git 仓库历史完整，包含所有提交记录。

## 第三方依赖

- Chromium 157.0.8079.0（BSD-3-Clause）
- 见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## 许可

本项目代码采用 [MIT License](LICENSE)。

---

*本文件由项目维护者创建，记录项目长期放弃的决定。*

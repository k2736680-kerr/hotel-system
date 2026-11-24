# 酒店管家（Hotel CRM）· Agent 持久记忆

> GitHub：`k2736680-kerr/hotel-system`（`~/AutoTestTools/Projects/hotel-system`）

## 是什么

**Windows 单机离线** Electron 酒店前台：房态、预订入住、账务、清洁报修、报表。SQLite 在 Electron userData，**无本地 HTTP 服务**。

## 怎么跑

```bash
cd ~/AutoTestTools/Projects/hotel-system
npm install
npm run dev        # 开发
npm test
npm run pack       # 未安装包
npm run dist       # NSIS → release/HotelButler-Setup-*-x64.exe
```

## 关键路径

- 代码：`src/` / `electron/`（按仓库实际布局）
- 文档：`docs/FUNCTIONAL_SPEC.md`、`docs/USER_GUIDE.md`、`docs/AUDIT_REPORT.md`
- 数据（运行时，不进仓库）：Windows `%APPDATA%\hotel-crm-local\`

## 勿动

- 生产数据在 userData；卸载默认**保留**数据。
- 恢复备份前程序会留安全副本，勿手删。

## Mac 注意

- **打包目标目前是 Windows x64 NSIS**；Mac 可 `npm run dev` 做部分前端/electron 开发，但交付物是 exe。
- 非主业时可低优先维护（见优化报告 P2）。

## 先读

- `README.md`
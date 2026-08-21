# 酒店管家

Windows 单机离线酒店前台应用。界面、业务服务和 SQLite 数据库均打包在 Electron 应用内，不启动本地 HTTP 服务。

## 已实现

- 房态总览、房型和房间维护。
- 首次注册管理员、账号登录、密码哈希和修改密码。
- 客户档案、证件去重和黑名单校验。
- 预订、取消、定金退款、预订转入住和入住冲突校验。
- 直接入住、同住人、续住、换房和按夜分段房费。
- 手工费用、优惠、费用作废、押金、收款和关联退款流水。
- 退房自动结算、补收/退款、退房转待清洁。
- 清洁确认、房间报修和停用控制。
- 每日经营报表和 CSV 导出。
- SQLite 持久化、事务、迁移、分页操作日志、每日单份滚动备份、手动备份和恢复。
- Electron 安全 IPC、完全离线前端资源、NSIS 安装包。

完整需求见 [功能需求文档](docs/FUNCTIONAL_SPEC.md)，交付结论见 [第三方审查报告](docs/AUDIT_REPORT.md)，实际操作见 [使用指南](docs/USER_GUIDE.md)。

## 本地运行

```powershell
npm install
npm run dev
```

## 验证与打包

```powershell
npm test
npm run pack
npm run dist
```

安装程序输出到 `release/HotelButler-Setup-<版本>-x64.exe`。

## 数据位置

数据库、日志和自动备份使用 Electron 的用户数据目录，不写入安装目录。Windows 下通常位于：

```text
%APPDATA%\hotel-crm-local\
```

卸载应用默认保留业务数据。恢复备份前，程序会自动保存当前数据库的安全副本。

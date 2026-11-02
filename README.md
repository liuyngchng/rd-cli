<div align="center">
 <img src="public/logo.svg" alt="rdCLI" width="64" height="64">
 <h1>rdCLI</h1>
 <p>AI 工作助手界面，支持本地或远程使用，随时随地进行日常办公文档处理。</p>
</div>

---

## 功能

- **响应式设计** - 在桌面、平板和移动设备上无缝运行
- **交互聊天界面** - 内置聊天 UI，轻松与 AI 助手交流
- **集成 Shell 终端** - 通过内置 shell 功能直接访问 CLI
- **文件浏览器** - 交互式文件树，支持语法高亮与实时编辑
- **会话管理** - 恢复对话、管理多个会话并跟踪历史记录
- **多用户支持** - 支持多用户注册与登录，管理员可管理用户

## 快速开始

```bash
npm install
npm run dev
```

打开 `http://localhost:5173` 即可使用。

## Windows 打包

在 Windows 机器上打包免安装版 rdCLI 桌面端：用户拿到 zip 解压后双击 `rdCLI.exe` 即可运行，无需安装、无需配置。

### 前置条件

- Windows 10 1803+ / Windows 11
- 已安装 [Node.js](https://nodejs.org/)（建议 22 LTS 或更新）
- **用户机器**需安装 [Microsoft Visual C++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)（约 14MB，Windows 上绝大多数软件都依赖此组件，通常已预装；若启动失败，安装后重启即可）

### 一键打包

在项目根目录执行（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\release\build-win.ps1
```

脚本会自动完成：配置国内镜像（electron 等二进制从 npmmirror 下载并缓存，首次约 130MB）→ 安装依赖 → 打包 `win-unpacked` → 压缩为 zip。

产物：`release/rdcli-desktop-<版本号>-win-x64.zip`

> 桌面包已内置 Claude Code CLI（体积约增加 290MB）：目标机器**无需安装 claude**。Claude 连接配置支持打包时注入（见下节「打包注入 Claude 配置」）；未注入时，用户需自行配置一次 API 密钥（写入 `C:\Users\<用户名>\.claude\settings.json` 的 `env` 块，或运行一次 `claude login`）。

> 脚本仅限 Windows 运行；在 Linux/WSL 上执行会直接报错退出，避免误打出 Linux 版。

### 打包注入 Claude 配置（可选）

Claude Code 默认直连 claude.com，国内环境需要走中转网关。为了让用户拿到 zip 后**开箱即用**，打包时可以把一份 `.env` 注入 `resources\app\.env`——app 启动时自动加载，中转地址、密钥、默认模型均从此读取。

构建机准备（二选一）：

1. **本地文件（推荐）**：复制模板并填写：
   ```powershell
   Copy-Item scripts\release\desktop.env.template scripts\release\desktop.env
   notepad scripts\release\desktop.env
   ```
   `desktop.env` 已加入 `.gitignore`，不会误提交。
2. **环境变量**：在构建机设置 `RDCLI_DESKTOP_ENV`，值即 `.env` 文件内容（`desktop.env` 文件存在时优先）。

模板中的配置项：

| 键 | 说明 |
|---|---|
| `ANTHROPIC_BASE_URL` | 中转网关地址，国内环境必填 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 密钥，二选一 |
| `ANTHROPIC_MODEL` | 可选，默认模型 |

注意：

- zip 内的 `.env` 是**明文**，拿到安装包的人都能看到密钥，请使用共享/有限额密钥；
- 用户升级解压新 zip 会覆盖 `resources\app\.env`（若用户自行改过该文件）；

> **用户自行配置**：如果打包时未注入 Claude 配置，用户解压后可在 `resources\app\` 目录下找到 `.env.template`，复制为 `.env` 并填写自己的中转地址和密钥，重启 rdCLI.exe 即可。

### 配置优先级

同一配置项可能出现在多个位置，最终生效的优先级从高到低为：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| ① | **系统/用户环境变量** | Windows「我的电脑 → 属性 → 高级 → 环境变量」中设置的变量，或启动 shell 中 `set` 的临时变量 |
| ② | **启动时传入的环境变量** | 启动 `rdCLI.exe` 时 shell 中已存在的变量（如 `set ANTHROPIC_API_KEY=xxx && rdCLI.exe`） |
| ③ | **`resources/app/.env` 文件** | 打包时注入的兜底配置，仅在①②均未设置同名变量时生效 |
| ④ | **代码内置默认值** | 最低优先级，如 `DATABASE_PATH` 默认 `~/.rdcli/auth.db` |

> 注意：如果用户的机器上已通过①或②设置了 `ANTHROPIC_API_KEY`，即使值为空或过期，`resources/app/.env` 中的预置值也会被**静默跳过**，不会覆盖。

### 调试日志

启动失败或需要排查后端启动过程时，可开启调试日志。在 `resources/app/.env` 文件末尾添加一行：

```ini
RDCLI_LOG_LEVEL=debug
```

重启 `rdCLI.exe` 后，启动日志会输出以 `[DEBUG]` 开头的详细诊断信息（数据库路径解析、原生模块加载、schema 应用等各步骤）。排查完成后删除或注释该行即可恢复正常日志。

### 常见问题

- **启动后提示「内置后端未就绪」或一直停留在「正在启动本地 rdCLI…」**：最常见的原因是缺少 VC++ 运行库。安装 [Microsoft Visual C++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)（约 14MB），重启 rdCLI 即可。若问题依旧，可按上文「调试日志」章节开启 `RDCLI_LOG_LEVEL=debug` 获取详细诊断信息。
- **"此系统上禁止运行脚本"**：PowerShell 默认执行策略拦截 `.ps1` 脚本。执行
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后即可直接运行
  `.\scripts\release\build-win.ps1`（仅影响当前用户，无需管理员权限）。
- **SmartScreen 提示"未知发布者"**：未做代码签名的正常现象，点「更多信息 → 仍要运行」即可。
- **首次打包较慢**：需下载 Windows 版 Electron（约 130MB），之后走本地缓存，很快。
- **报"字符串缺少终止符"或中文乱码**：脚本需以 UTF-8 带 BOM 编码保存（Windows PowerShell 5.1
  会把无 BOM 的 UTF-8 按 GBK 读取）。仓库内的脚本已是正确编码，若自行编辑后出现此错，用以下命令重新保存：

  ```powershell
  $p = "$PWD\scripts\release\build-win.ps1"
  $c = Get-Content -Raw -Encoding UTF8 $p
  [System.IO.File]::WriteAllText($p, $c, (New-Object System.Text.UTF8Encoding $true))
  ```

### 手动打包（可选）

需要单文件 exe 或手动控制流程时：

```powershell
npm install
npm run build
npm run desktop:stage
# 文件夹版（启动快，推荐）：产物 release/desktop/win-unpacked/
npx electron-builder --projectDir .desktop-build/desktop-app --win dir
# 单文件便携版（首次启动需解压，略慢）：产物 release/desktop/
npx electron-builder --projectDir .desktop-build/desktop-app --win portable
```

## Linux 打包

在 Linux 机器上打包 rdCLI 桌面端（以 Ubuntu 为主），产出 AppImage 与 deb 两种格式。

### 前置条件

- Ubuntu 20.04+（或其他主流 Linux 发行版）
- 已安装 [Node.js](https://nodejs.org/)（建议 22 LTS 或更新）
- 安装系统依赖（deb 打包需要 `fakeroot`）：

  ```bash
  sudo apt-get update
  sudo apt-get install -y fakeroot dpkg
  ```

### 一键打包

在项目根目录执行：

```bash
bash scripts/release/build-linux.sh
```

脚本会自动完成：配置国内镜像（electron 等二进制从 npmmirror 下载并缓存）→ 安装依赖 → 生成 desktop stage → 打包 AppImage + deb。

产物：

- `release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage`
- `release/desktop/rdcli-desktop-<版本号>-linux-x64.deb`

> 桌面包已内置 Claude Code CLI（体积约增加 290MB）：目标机器**无需安装 claude**，只需为 Claude 配置一次 API 密钥（写入 `~/.claude/settings.json` 的 `env` 块，或运行一次 `claude login`）。

> 脚本仅限 Linux 运行；在 Windows/WSL 上执行会直接报错退出，避免误打出 Windows 版。

### 使用方式

- **AppImage**：给文件加执行权限后直接运行，免安装：

  ```bash
  chmod +x release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
  ./release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
  ```

  > **Ubuntu 22.04+ 注意**：系统默认不带 `libfuse2`，首次运行前需安装：
  > ```bash
  > sudo apt install libfuse2
  > ```
  > 不想安装 libfuse2 的话，也可以用 `--appimage-extract-and-run` 直接运行（每次都要加这个参数）。

- **deb**：通过包管理器安装，可自动写入应用菜单与 `.desktop` 启动项：

  ```bash
  sudo apt install ./release/desktop/rdcli-desktop-<版本号>-linux-x64.deb
  ```

### 手动打包（可选）

需要单独控制格式或流程时：

```bash
npm install
npm run build
npm run desktop:stage
# 仅 AppImage（免安装）：产物 release/desktop/rdcli-desktop-<版本号>-linux-x64.AppImage
npx electron-builder --projectDir .desktop-build/desktop-app --linux AppImage
# 仅 deb（可安装）：产物 release/desktop/rdcli-desktop-<版本号>-linux-x64.deb
npx electron-builder --projectDir .desktop-build/desktop-app --linux deb
```

> 也可用 npm 脚本一键完成 build + stage + 打包：`npm run desktop:dist:linux`

## 部署

### Docker 部署（Linux 服务器）

项目根目录提供 `deploy/deploy.sh` 一键部署脚本。

**前置注意**：容器内进程以 uid=1000 运行。若服务器当前用户 uid 不是 1000，每次部署需按顺序执行：

```bash
# 1. 把数据目录还给当前用户，让 mkdir 能跑
sudo chown -R $(id -u):$(id -g) /data1/app/rd-cli/data/rdcli

# 2. 启动容器
./deploy/deploy.sh

# 3. 容器起来后，把目录还给容器进程（uid=1000），让它能读写
#    另开终端或在 Ctrl+C 退出日志后执行：
sudo chown -R 1000:1000 /data1/app/rd-cli/data/rdcli
docker restart my_rd-cli
```

> 首次部署时目录尚不存在，第 1 步可跳过。后续每次重跑都需要这三步循环。

### 用户管理



## 许可证

GNU 通用公共许可证 v3.0 - 详见 LICENSE 文件。

该项目为开源软件，在 GPL v3 许可证下可自由使用、修改与分发。

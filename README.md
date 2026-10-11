# ESP32 LED 控制器

通过浏览器 Web Serial API，经 USB 串口控制 ESP32 的 LED，支持常亮、熄灭、闪烁、真正的 PWM 呼吸灯和标准 SOS，可收藏灯效、读取设备状态，并配置 ESP32 接入 Wi-Fi。网页无前端依赖，无需安装 Node.js（运行开发测试时需要）。

## 硬件和环境

- ESP32 DevKit / ESP32-WROOM，默认 GPIO 2、高电平点亮。
- 支持数据传输的 USB 线。
- Python 3.10 或更新版本（本项目使用 Python 3.12 验证）、Make。
- 桌面版 Chrome 或 Edge；Safari / Firefox 不支持 Web Serial。

部分开发板没有可控制的板载 LED，或引脚、有效电平不同。请以开发板原理图为准，修改固件中的 `LED_PIN` / `LED_ACTIVE_LOW`。外接普通 LED 时应串联限流电阻；本固件不适用于 WS2812 等可寻址 RGB 灯。

## 快速开始

在项目目录执行：

```sh
make setup
make build
make ports
make upload
make serve
```

首次构建会下载 ESP32 平台、Arduino 框架和编译工具链，需要联网。PlatformIO 安装到项目 `.venv`，构建产物位于 `.pio`。

用 Chrome / Edge 打开 <http://localhost:8000/esp32_led_control.html>，点击「连接串口」并选择 ESP32。首次连接和重连会先读取设备当前设定，随后即可切换模式、调整灯效参数与亮度。页面使用 ES modules，请通过 `make serve` 访问，直接双击 HTML 文件无法加载模块。

`make serve` 只启动网页服务器，不会烧录板子。首次使用或升级灯效 / 协议后需执行 `make upload`。如果设备回复 `ERR unknown command: STATUS`，说明板子仍是旧版固件，需要先烧录 v2 固件再连接。

如果系统默认 Python 版本不适合，可在首次安装时指定：

```sh
make setup PYTHON=python3.12
```

连接多个串口设备时，指定端口烧录：

```sh
make upload PORT=/dev/cu.usbserial-XXXX
make monitor PORT=/dev/cu.usbserial-XXXX
```

端口名称以 `make ports` 输出为准；Windows 示例为 `PORT=COM3`。串口波特率为 **115200**。串口监视器与浏览器不能同时占用同一端口，连接网页前退出监视器（Ctrl+C）。`make serve HTTP_PORT=8080` 可更换网页端口，Ctrl+C 停止服务器。

如果烧录一直停留在连接阶段，可尝试按住开发板 BOOT 键开始上传，建立连接后松开；部分 USB 芯片需要安装对应厂商的驱动。

## Arduino IDE

也可以在 Arduino IDE 中安装 Espressif 的 ESP32 板卡支持包，打开 `esp32_led_control/esp32_led_control.ino`，选择 **ESP32 Dev Module** 和设备端口后上传。PlatformIO 固定使用 `espressif32@6.12.0` 及其 Arduino 框架。

## 第一阶段功能

- **呼吸灯**：PWM 按余弦曲线从 0 平滑升到设定峰值，再平滑回到 0；周期范围 200–60000 ms，默认 3000 ms。调整峰值亮度不会重启周期。
- **标准 SOS**：重复发送 `··· −−− ···`。短亮 1 单位、长亮 3 单位；码内间隔 1 单位、字母间隔 3 单位、重复间隔 7 单位。完整一轮 34 单位，默认单位 150 ms，范围 50–2000 ms。
- **灯效收藏**：命名、保存、调用、删除，最多 20 个；保存模式、亮度和时间参数。收藏保存在当前浏览器的 localStorage，刷新后保留，不会写入板子。更换浏览器、网址端口或清理网站数据会影响收藏。
- **状态同步**：设备接受命令后立即回报状态，并每秒主动回报一次。网页显示实际设定、瞬时 PWM、GPIO 和运行时间，预览按设备时间相位模拟。超过 3.5 秒没有有效状态会显示过期并暂停预览；命令响应超过 2.5 秒会断开会话，防止迟到的确认误匹配后续命令。

未连接时可以预览、调参和收藏；连接时收藏设备已确认的灯效，命令发送中不能保存。重连会以板子状态回填控件，不会自动把离线预览写到板子；需要应用某个收藏时点击对应收藏。

桌面页面将灯效控制和预览并排展示，设备反馈位于预览下方，收藏与日志放在第二行。滑块旁的数值框可精确输入参数，Enter 或移开焦点时会将超出范围的值限制到有效范围；周期曲线随模式、亮度和时间参数变化，连接后以设备回报的灯效和相位为准。

灯控和首次配网使用 USB 串口；当前 Wi-Fi 功能用于让板子接入网络，无线灯控和 OLED 显示留待下一阶段。手机尺寸页面可查看和预览。请上传最新固件，旧固件可能不支持 Wi-Fi。上电默认仍是亮度 255、500 / 500 ms 闪烁；灯效设定未写入非易失存储，断电后恢复默认。

## Wi-Fi 接入

1. 执行 `make upload` 更新固件，执行 `make serve`，用 Chrome / Edge 打开控制页并连接串口。
2. 在「Wi-Fi 配网」点击 **扫描附近 Wi-Fi**，等待列表出现，点击网络后自动填入名称。列表按信号强度排序，同名且加密状态相同的接入点合并显示，最多返回信号最强的 20 个接入点。只扫描 ESP32 能接收的 **2.4 GHz** 网络；隐藏网络可手动输入名称。扫描期间仍能控制灯效；为避免连接与扫描冲突，正在连接 Wi-Fi 时需等待本次尝试结束再扫描。关闭 Wi-Fi 或尚未配网时也可以扫描，完成后恢复关闭状态，不会自动连接。
3. 输入密码，点击「保存并连接」。名称按原样使用，支持中文、空格和引号；名称最多 32 个 UTF-8 字节。密码支持 8–63 个可打印英文字符（包括空格、符号），或 64 位十六进制 PSK；开放网络可留空。暂不支持企业 Wi-Fi 的账号认证。
4. 命令确认只表示配置已保存、已开始尝试连接。等待上方显示「已连接 Wi-Fi」以及 IP 地址和信号强度，才表示接入成功。

配置保存在 ESP32 的 NVS `led-wifi` 命名空间，断电后保留；每次上电自动连接。单次连接最多等待 15 秒，失败或掉线后等待 30 秒再重试，灯效和串口响应继续运行。网页每秒显示设备实际网络状态与错误原因；如果路由器不在附近或密码有误，可修改配置后重新保存。

- **重新连接**：立即使用板子上已保存的网络配置重试。
- **关闭 Wi-Fi**：停止联网和重试，保留配置；重启会自动连接。
- **清除网络配置**：关闭 Wi-Fi 并删除保存的名称与密码，重启后也不再自动连接。

密码不回传、不记录到网页日志或 localStorage，提交后清空输入框。串口使用十六进制编码传输凭据，以兼容空格和中文；编码不是加密，NVS 配置也未加密。配网需 USB 连接，不会自动读取电脑的 Wi-Fi 密码。

## 串口协议

ASCII 文本命令，每行以换行符 `\n` 结尾，大小写不敏感。

| 命令 | 行为 | 回复 |
| --- | --- | --- |
| `ON` | 常亮 | `OK ON` + `STATUS ...` |
| `OFF` | 熄灭 | `OK OFF` + `STATUS ...` |
| `BLINK 500 500` | 亮 500 ms、灭 500 ms；每段限于 10–60000 ms | `OK BLINK 500 500` + `STATUS ...` |
| `BRIGHT 128` | 设置 PWM 亮度，范围 0–255 | `OK BRIGHT 128` + `STATUS ...` |
| `BREATHE 3000` | 呼吸周期 3000 ms；范围 200–60000 ms | `OK BREATHE 3000` + `STATUS ...` |
| `SOS 150` | SOS 单位 150 ms；范围 50–2000 ms | `OK SOS 150` + `STATUS ...` |
| `STATUS` | 读取完整设备状态，不改变灯效 | `STATUS {…}` |
| `PING` | 连通性检查 | `PONG` |
| `WIFI SET <ssid_hex> <password_hex>` | 保存网络配置并开始连接；开放网络密码使用 `-` | `OK WIFI SET` + `STATUS ...` |
| `WIFI CONNECT` | 使用保存的配置立即重连 | `OK WIFI CONNECT` + `STATUS ...` |
| `WIFI OFF` | 关闭 Wi-Fi，保留配置 | `OK WIFI OFF` + `STATUS ...` |
| `WIFI CLEAR` | 关闭 Wi-Fi 并清除网络配置 | `OK WIFI CLEAR` + `STATUS ...` |
| `WIFI SCAN` | 开始异步扫描可见的附近网络 | 立即 `OK WIFI SCAN` + `STATUS ...`，完成后 `WIFI_SCAN {…}` |

参数超出范围时固件会限制到有效范围；非法命令、缺少参数或多余参数会回复 `ERR ...`。`BRIGHT` 不改变模式或重置时间相位；灯效命令从新周期开始。固件通过非阻塞时间计算更新 PWM，播放灯效期间仍能响应串口命令。

状态格式示例：

```text
STATUS {"version":2,"mode":"breathe","brightness":128,"on_ms":500,"off_ms":500,"breathe_ms":3000,"sos_unit_ms":150,"elapsed_ms":1500,"uptime_ms":12000,"led_duty":128,"pin":2}
```

`brightness` 是亮度设定 / 峰值；`led_duty` 是固件当前输出的逻辑 PWM 值，0 表示灭，255 表示最亮。`elapsed_ms` 用于同步动画相位。设备反馈来自固件，无光学传感器；网页预览和实物可能因串口延迟、LED 特性存在差异。

最新固件在上述 v2 状态中增加 `wifi` 对象：

```json
{"state":"connected","ssid":"Desk WiFi","ip":"192.168.1.42","rssi":-54,"error":""}
```

`state` 为 `unconfigured` / `connecting` / `connected` / `retry_wait` / `off`；未连接时 `ip` 为空、`rssi` 为 0。`error` 可能为 `connect_failed` / `ssid_unavailable` / `timeout` / `connection_lost` / `storage_failed`，成功连接后清空。旧版 v2 固件仍可控制灯效，但网页会提示升级才能配网。最大串口命令长度为 255 字节；Wi-Fi 参数无效或 NVS 写入失败会返回 `ERR`，不会开始连接新网络。

支持扫描的固件在 `wifi` 对象中追加 `scan_supported: true` 和 `scanning` 布尔值。扫描最多等待 15 秒；扫描期间暂不接受其他 Wi-Fi 操作，也暂停自动重连尝试。完成后发送独立结果，例如 `WIFI_SCAN {"error":"","truncated":false,"networks":[{"ssid":"Desk WiFi","rssi":-54,"secure":true}]}`。`secure: false` 表示开放网络，`truncated` 表示扫描结果被数量限制截断；扫描失败时 `error` 为 `scan_failed` 或 `timeout`。结果不是灯控命令的确认，不会干扰灯控响应队列；网页串口单行缓冲上限为 8192 字符，兼容较长的扫描列表。

## 项目结构

```text
esp32_led_control/esp32_led_control.ino  Arduino 固件
esp32_led_control/effects.h            非阻塞灯效计算
esp32_led_control/network.h            Wi-Fi 配网、NVS 保存和连接重试
esp32_led_control.html                 Web Serial 控制页面
web/app.mjs                           页面交互、设备状态和预览
web/styles.css                        桌面工作台与响应式样式
web/effects.mjs                        浏览器灯效计算和协议校验
web/serial.mjs                         串口队列、确认、超时和断线处理
web/favorites.mjs                      收藏持久化
web/wifi.mjs                           配网校验、编码、状态与日志脱敏
tests/                               主机侧固件及网页模块测试
platformio.ini                         ESP32 DevKit 构建配置
requirements-dev.txt                   PlatformIO 版本
Makefile                               安装、构建、烧录和网页启动命令
```

运行 `make help` 查看可用命令。

## 验证

```sh
make test   # Node.js 18+ 和支持 C++17 的编译器；不需要连接板子
make build  # 使用 ESP32 工具链编译实际固件
```

测试覆盖呼吸曲线、完整 SOS 间隔及重复、亮度为零、参数校验、毫秒计数回绕、串口分包 / 命令队列 / 错误 / 超时 / 断线、收藏持久化及损坏数据，以及 Wi-Fi 凭据编码与日志脱敏、NVS 写入失败、重启加载、断线重试、关闭与清除配置、异步扫描、空列表、扫描超时、信号排序与去重、长扫描列表分包。主机测试使用 Wi-Fi / NVS 替身，不替代实物连接：烧录后确认 LED 灯效和串口回报，扫描附近网络，再配置真实网络，检查获取 IP、重启自动联网与断网后的重连。

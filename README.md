# ESP32 LED 控制器

通过浏览器 Web Serial API，经 USB 串口控制 ESP32 的 LED，支持常亮、熄灭、闪烁、真正的 PWM 呼吸灯和标准 SOS，可收藏灯效并读取设备状态。网页无前端依赖，无需安装 Node.js（运行开发测试时需要）。

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

本阶段使用 USB 串口，不包含 Wi-Fi。手机尺寸页面可查看和预览，手机无线控制留待下一阶段。请上传 v2 固件，旧固件不能完成状态同步。上电默认仍是亮度 255、500 / 500 ms 闪烁；灯效设定未写入非易失存储，断电后恢复默认。

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

参数超出范围时固件会限制到有效范围；非法命令、缺少参数或多余参数会回复 `ERR ...`。`BRIGHT` 不改变模式或重置时间相位；灯效命令从新周期开始。固件通过非阻塞时间计算更新 PWM，播放灯效期间仍能响应串口命令。

状态格式示例：

```text
STATUS {"version":2,"mode":"breathe","brightness":128,"on_ms":500,"off_ms":500,"breathe_ms":3000,"sos_unit_ms":150,"elapsed_ms":1500,"uptime_ms":12000,"led_duty":128,"pin":2}
```

`brightness` 是亮度设定 / 峰值；`led_duty` 是固件当前输出的逻辑 PWM 值，0 表示灭，255 表示最亮。`elapsed_ms` 用于同步动画相位。设备反馈来自固件，无光学传感器；网页预览和实物可能因串口延迟、LED 特性存在差异。

## 项目结构

```text
esp32_led_control/esp32_led_control.ino  Arduino 固件
esp32_led_control/effects.h            非阻塞灯效计算
esp32_led_control.html                 Web Serial 控制页面
web/app.mjs                           页面交互、设备状态和预览
web/styles.css                        桌面工作台与响应式样式
web/effects.mjs                        浏览器灯效计算和协议校验
web/serial.mjs                         串口队列、确认、超时和断线处理
web/favorites.mjs                      收藏持久化
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

测试覆盖呼吸曲线、完整 SOS 间隔及重复、亮度为零、参数校验、毫秒计数回绕、串口分包 / 命令队列 / 错误 / 超时 / 断线、收藏持久化及损坏数据。主机测试不替代实物验证：烧录后确认 LED 逐渐变亮变暗、三短三长三短及重复间隔、拖动参数后的设备回报和拔插后的重连。

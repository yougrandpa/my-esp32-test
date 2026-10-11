#include <cassert>
#include <iostream>
#include <vector>
#include <future>
#define DESK_NO_HARDWARE
#include "../esp32_led_control/esp32_led_control.ino"

std::string command(const std::string& text) {
  Serial.output.clear();
  for (char c : text + "\n") Serial.input.push_back(c);
  while (Serial.available()) handleSerial();
  return Serial.output;
}

void request(const char* path, HTTPMethod method, std::map<std::string, std::string> values = {}) {
  auto response = std::async(std::launch::async, [&]() { httpControl.server.request(path, method, values); });
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (response.wait_for(std::chrono::milliseconds(1)) != std::future_status::ready) {
    assert(std::chrono::steady_clock::now() < deadline);
    loop();
  }
  response.get();
}

int main() {
  setup();
  assert(effect.mode == MODE_BLINK && testDuty == 255);
  assert(command("BREATHE 3000").find("OK BREATHE 3000\nSTATUS ") == 0);
  assert(effectDuty(effect, 0) == 0);
  assert(effectDuty(effect, 750) == 128);
  assert(effectDuty(effect, 1500) == 255);
  assert(effectDuty(effect, 2250) == 128);
  assert(effectDuty(effect, 3000) == 0);
  int previous = 0;
  for (int ms = 0; ms <= 1500; ++ms) {
    const int duty = effectDuty(effect, ms);
    assert(duty >= previous && duty <= 255);
    previous = duty;
  }
  testTime = 750;
  command("BRIGHT 80");
  assert(effectStart == 0 && testDuty == 40); // Brightness does not restart breathing.
  command("BRIGHT 0");
  for (int ms = 0; ms < 3000; ++ms) assert(effectDuty(effect, ms) == 0);

  command("BRIGHT 255");
  command("SOS 150");
  // Build independent Morse expectations: ... / --- / ... plus repeat gap.
  std::vector<int> expected;
  for (int letter = 0; letter < 3; ++letter) {
    for (int mark = 0; mark < 3; ++mark) {
      expected.insert(expected.end(), letter == 1 ? 3 : 1, 255);
      expected.insert(expected.end(), mark < 2 ? 1 : letter < 2 ? 3 : 7, 0);
    }
  }
  assert(expected.size() == 34);
  for (uint32_t unitMs : {50u, 150u, 2000u}) {
    effect.sosUnitMs = unitMs;
    for (unsigned unit = 0; unit < expected.size(); ++unit) {
      assert(effectDuty(effect, unit * unitMs) == expected[unit]);
      assert(effectDuty(effect, (unit + 1) * unitMs - 1) == expected[unit]);
      assert(effectDuty(effect, (unit + 34) * unitMs) == expected[unit]);
    }
  }
  command("BLINK 10 20");
  assert(effectDuty(effect, 9) == 255 && effectDuty(effect, 10) == 0);
  assert(effectDuty(effect, 29) == 0 && effectDuty(effect, 30) == 255);
  command("BLINK -1 999999");
  assert(effect.onMs == 10 && effect.offMs == 60000);
  command("BREATHE 1");
  assert(effect.breatheMs == 200);
  command("SOS 9999");
  assert(effect.sosUnitMs == 2000);
  for (const char* invalid : {"BREATHE", "BREATHE x", "SOS 1 2", "BLINK 1", "BRIGHT 1x", "ON extra", "STATUS extra", "BRIGHT 999999999999999999999999"}) {
    assert(command(invalid).find("ERR ") == 0);
    assert(effect.mode == MODE_SOS && effect.brightness == 255);
  }
  assert(command(std::string(300, 'X')) == "ERR command too long\n");
  assert(command("PING\r") == "PONG\n");
  assert(command("off\t").find("OK OFF\nSTATUS ") == 0 && testDuty == 0);
  command("BLINK 10 20");
  effectStart = 0xfffffffa;
  testTime = 4; // millis() rollover: elapsed = 10 ms, first off segment.
  const auto status = command("STATUS");
  assert(status.find("\"elapsed_ms\":10") != std::string::npos);
  assert(status.find("\"led_duty\":0") != std::string::npos);
  assert(testDuty == 0);
  Serial.output.clear();
  testTime += 1000;
  loop();
  assert(Serial.output.find("STATUS ") == 0);

  assert(!WiFi.driverPersistence && !WiFi.autoReconnect);
  assert(!strcmp(network.state, "unconfigured"));
  // Quoted/space-containing SSID and a password with whitespace are lossless.
  const auto configured = command("WIFI SET 4465736b20224c454422 7061737320776f7264");
  assert(configured.find("OK WIFI SET\nSTATUS ") == 0);
  assert(configured.find("pass word") == std::string::npos);
  assert(configured.find("7061737320776f7264") == std::string::npos);
  assert(WiFi.ssid == "Desk \"LED\"" && WiFi.password == "pass word");
  assert(configured.find("Desk \\\"LED\\\"") != std::string::npos);
  assert(!strcmp(network.state, "connecting"));
  const int attempts = WiFi.begins;
  const auto saved = Preferences::values;
  for (const char* invalid : {"WIFI", "WIFI SET", "WIFI SET 0 70617373776f7264", "WIFI SET 00 -", "WIFI SET 4142 73686f7274", "WIFI SET 4142 - extra", "WIFI CLEAR extra", "WIFI OFF extra", "WIFI CONNECT extra"}) {
    assert(command(invalid).find("ERR ") == 0);
    assert(WiFi.begins == attempts && Preferences::values == saved);
  }
  Preferences::failWrites = true;
  assert(command("WIFI SET 4e6577 -").find("ERR Wi-Fi storage failed") == 0);
  assert(command("WIFI CLEAR").find("ERR Wi-Fi storage failed") == 0);
  assert(WiFi.begins == attempts && Preferences::values == saved);
  Preferences::failWrites = false;

  // LED and serial commands remain responsive during a failed Wi-Fi attempt.
  command("BREATHE 3000");
  testTime = network.since + 750;
  loop();
  assert(testDuty == 128);
  assert(command("PING") == "PONG\n");
  testTime = network.since + 15000;
  loop();
  assert(!strcmp(network.state, "retry_wait") && !strcmp(network.error, "timeout"));
  testTime += 29999;
  loop();
  assert(WiFi.begins == attempts);
  ++testTime;
  loop();
  assert(WiFi.begins == attempts + 1 && !strcmp(network.state, "connecting"));
  WiFi.currentStatus = WL_CONNECTED;
  loop();
  const auto online = command("STATUS");
  assert(online.find("\"ip\":\"192.168.1.42\"") != std::string::npos);
  assert(online.find("\"rssi\":-54") != std::string::npos);
  WiFi.currentStatus = WL_DISCONNECTED;
  loop();
  assert(!strcmp(network.error, "connection_lost"));
  assert(command("STATUS").find("\"ip\":\"\"") != std::string::npos);
  command("WIFI OFF");
  const int offAttempts = WiFi.begins;
  testTime += 60000;
  loop();
  assert(!strcmp(network.state, "off") && WiFi.begins == offAttempts);
  Network rebooted;
  rebooted.begin();
  assert(!strcmp(rebooted.state, "connecting") && WiFi.ssid == "Desk \"LED\"");
  assert(command("WIFI CONNECT").find("OK WIFI CONNECT") == 0);
  // Timeout/retry arithmetic also works across millis rollover.
  network.since = 0xfffffff0;
  testTime = 14984;
  loop();
  assert(!strcmp(network.state, "retry_wait"));
  assert(command("WIFI SET 43616665 -").find("OK WIFI SET") == 0);
  assert(WiFi.password.empty());
  assert(command("WIFI CLEAR").find("OK WIFI CLEAR") == 0);
  Network cleared;
  cleared.begin();
  assert(!strcmp(cleared.state, "unconfigured"));
  assert(network.password[0] == 0 && network.ssid[0] == 0);
  assert(command("WIFI CONNECT").find("ERR Wi-Fi not configured") == 0);
  // Scanning from an unconfigured device temporarily enables the radio.
  WiFi.accessPoints = {{"Weak", -90, 3}, {"Desk \"LED\"", -40, 3}, {"Cafe", -55, WIFI_AUTH_OPEN}};
  const auto scanning = command("WIFI SCAN");
  assert(scanning.find("OK WIFI SCAN") == 0 && network.scanning);
  assert(scanning.find("\"scanning\":true") != std::string::npos);
  assert(WiFi.radioMode == WIFI_STA);
  assert(command("WIFI SCAN").find("ERR Wi-Fi scan in progress") == 0);
  assert(command("WIFI OFF").find("ERR Wi-Fi scan in progress") == 0);
  assert(command("PING") == "PONG\n");
  command("BREATHE 3000");
  testTime += 750;
  loop();
  assert(testDuty == 128 && network.scanning);
  WiFi.scanResult = WiFi.accessPoints.size();
  Serial.output.clear();
  loop();
  assert(!network.scanning && WiFi.radioMode == WIFI_OFF);
  assert(Serial.output.find("WIFI_SCAN {\"error\":\"\"") == 0);
  assert(Serial.output.find("Desk \\\"LED\\\"") < Serial.output.find("Cafe"));
  assert(Serial.output.find("Cafe") < Serial.output.find("Weak"));
  assert(Serial.output.find("\"secure\":false") != std::string::npos);
  WiFi.accessPoints.clear();
  command("WIFI SCAN");
  WiFi.scanResult = 0;
  Serial.output.clear();
  loop();
  assert(Serial.output.find("\"networks\":[]") != std::string::npos);
  // A stalled scan is bounded, including across millis rollover.
  testTime = 0xfffffff0;
  command("WIFI SCAN");
  testTime = 14984;
  Serial.output.clear();
  loop();
  assert(!network.scanning && Serial.output.find("\"error\":\"timeout\"") != std::string::npos);
  WiFi.failScanStart = true;
  assert(command("WIFI SCAN").find("ERR Wi-Fi scan failed to start") == 0);
  assert(!network.scanning && WiFi.radioMode == WIFI_OFF);
  WiFi.failScanStart = false;
  command("WIFI SET 4465736b 70617373776f7264");
  assert(command("WIFI SCAN").find("ERR Wi-Fi is connecting") == 0);
  WiFi.currentStatus = WL_CONNECTED;
  loop();
  command("WIFI SCAN");
  WiFi.scanResult = 0;
  loop();
  assert(WiFi.currentStatus == WL_CONNECTED && WiFi.radioMode == WIFI_STA);
  command("WIFI OFF");
  command("WIFI SCAN");
  WiFi.scanResult = WIFI_SCAN_FAILED;
  Serial.output.clear();
  loop();
  assert(!strcmp(network.state, "off") && WiFi.radioMode == WIFI_OFF);
  assert(Serial.output.find("\"error\":\"scan_failed\"") != std::string::npos);
  assert(!httpControl.running);
  command("WIFI CONNECT");
  WiFi.currentStatus = WL_CONNECTED;
  loop();
  httpControl.service();
  assert(httpControl.running && httpControl.server.starts >= 1);
  auto& web = httpControl.server;
  request("/", HTTP_GET);
  assert(web.statusCode == 200 && web.body.size() > 1000);
  assert((unsigned char)web.body[0] == 0x1f && (unsigned char)web.body[1] == 0x8b);
  assert(web.responseHeaders["Content-Encoding"] == "gzip");
  request("/web/http.mjs", HTTP_GET);
  assert(web.statusCode == 200 && web.mime == "application/javascript; charset=utf-8");
  request("/api/status", HTTP_GET);
  assert(web.statusCode == 200);
  const auto serialStatus = command("STATUS");
  assert(serialStatus == "STATUS " + web.body + "\n");
  assert(web.body.find("password") == std::string::npos);
  request("/api/command", HTTP_POST, {{"command", "ON"}});
  assert(web.statusCode == 200 && effect.mode == MODE_ON && testDuty == effect.brightness);
  assert(web.body.find("\"reply\":\"OK ON\"") != std::string::npos);
  command("BRIGHT 80");
  request("/api/status", HTTP_GET);
  assert(web.body.find("\"brightness\":80") != std::string::npos);
  const auto phase = effectStart;
  request("/api/command", HTTP_POST, {{"command", "BRIGHT 9999"}});
  assert(effect.brightness == 255 && effectStart == phase);
  assert(web.body.find("OK BRIGHT 255") != std::string::npos);
  for (const char* invalid : {"", "OFF\nON", "BREATHE bad", "WIFI OFF", "WIFI SET 4465736b 70617373776f7264"}) {
    request("/api/command", HTTP_POST, {{"command", invalid}});
    assert(web.statusCode == 400 && effect.mode == MODE_ON && effect.brightness == 255);
  }
  request("/api/command", HTTP_POST, {{"command", std::string(256, 'x')}});
  assert(web.statusCode == 400);
  request("/api/command", HTTP_POST);
  assert(web.statusCode == 400);
  request("/api/command", HTTP_POST, {{"command", "ON"}, {"extra", "x"}});
  assert(web.statusCode == 400);
  web.headers["Origin"] = "http://elsewhere.example";
  request("/api/command", HTTP_POST, {{"command", "OFF"}});
  assert(web.statusCode == 403 && effect.mode == MODE_ON);
  web.headers["Origin"] = "http://192.168.1.42";
  request("/api/command", HTTP_POST, {{"command", "PING"}});
  assert(web.statusCode == 200 && web.body.find("PONG") != std::string::npos);
  request("/api/status", HTTP_POST);
  assert(web.statusCode == 404);
  command("WIFI OFF");
  loop();
  httpControl.service();
  assert(!httpControl.running && web.stops >= 1);
  const auto beforeRestart = web.starts;
  command("WIFI CONNECT");
  WiFi.currentStatus = WL_CONNECTED;
  loop();
  httpControl.service();
  assert(httpControl.running && web.starts == beforeRestart + 1);

  // Empty Chrome preconnections must not occupy the sole HTTP client for 5 s.
  web.clientConnected = true; web.clientBytes = 0;
  const auto idleStart = testTime;
  httpControl.service();
  testTime = idleStart + 249; httpControl.service(); assert(web.clientConnected);
  testTime = idleStart + 250; httpControl.service(); assert(!web.clientConnected && web.idleStops == 1);
  web.clientConnected = true; web.clientBytes = 1;
  testTime += 1000; httpControl.service(); assert(web.clientConnected && web.idleStops == 1);
  web.clientConnected = false; web.clientBytes = 0;
  // A stalled HTTP read/write must not stop PWM updates or USB commands.
  std::promise<void> entered, release;
  auto released = release.get_future().share();
  web.handleClientHook = [&]() { entered.set_value(); released.wait(); };
  auto stalledHttp = std::async(std::launch::async, [&]() { httpControl.service(); });
  entered.get_future().wait();
  command("BRIGHT 255");
  command("BREATHE 2000");
  const auto started = effectStart;
  for (uint32_t elapsed : {0u, 500u, 1000u, 1500u, 2000u}) {
    testTime = started + elapsed;
    loop();
    assert(testDuty == effectDuty(effect, elapsed));
    assert(stalledHttp.wait_for(std::chrono::milliseconds(0)) == std::future_status::timeout);
  }
  assert(command("PING") == "PONG\n");
  release.set_value();
  stalledHttp.get();
  web.handleClientHook = {};
  request("/api/status", HTTP_GET);
  assert(web.statusCode == 200 && web.body.find("\"mode\":\"breathe\"") != std::string::npos);
  // A complete automatic rotation must reach every forecast day and todo slot.
  bool forecastSeen[3] = {}, todoSeen[6] = {};
  DeskConfig rotation;
  for (uint32_t now = 0; now < 144000; now += 1000) {
    if (deskPageAt(rotation, now) == 2) forecastSeen[deskRotationAt(rotation, now, 8000, 3)] = true;
    if (deskPageAt(rotation, now) == 3) todoSeen[deskRotationAt(rotation, now, 12000, 6)] = true;
  }
  for (bool seen : forecastSeen) assert(seen);
  for (bool seen : todoSeen) assert(seen);
  rotation.page = 3;
  assert(deskPageAt(rotation, 0) == 3 && deskRotationAt(rotation, 12000, 12000, 6) == 1);
  assert(deskRotationAt(rotation, 0, 12000, 0) == 0);
  // Persistent desk settings, bounded commands, Unicode and alarm lifecycle.
  assert(std::string(desk.config.city) == "长沙" && desk.config.offset == 480);
  assert(command("DESK TIME 1791676800").find("OK DESK\nSTATUS ") == 0);
  assert(desk.epoch == 1791676800u);
  assert(command("DESK LOCATION 28.2282 112.9388 480 e995bfe6b299").find("OK DESK") == 0);
  assert(command("DESK TODO 0 1791676800 e5969de6b0b4").find("OK DESK") == 0); // 喝水
  assert(desk.alarm() == 0);
  command("DESK TODO 1 1791676799 e4bc9ae8aeae"); // Earlier overdue item takes priority.
  assert(desk.alarm() == 1);
  command("DESK DISMISS 1");
  assert(desk.alarm() == 0 && desk.config.todos[1].dismissed);
  command("DESK DONE 0 1");
  assert(desk.alarm() == -1);
  command("DESK DONE 0 0");
  assert(desk.alarm() == 0 && !desk.config.todos[0].dismissed);
  const auto savedDesk = desk.config;
  const auto revision = desk.revision;
  for (const char* invalid : {"DESK", "DESK TODO 6 0 41", "DESK TODO 0 1 41", "DESK TODO 0 0 00", "DESK TODO 0 0 0a", "DESK TODO 0 0 c080", "DESK TODO 0 0 eda080", "DESK TODO 0 0 e4b8", "DESK LOCATION nan 112 480 41", "DESK LOCATION 91 112 480 41", "DESK LOCATION 28 112 841 41", "DESK DONE 0 2", "DESK PAGE 4", "DESK REFRESH extra", "DESK TIME 0"}) {
    assert(command(invalid).find("ERR ") == 0);
    assert(desk.revision == revision);
  }
  Preferences::failWrites = true;
  assert(command("DESK DELETE 0").find("ERR ") == 0);
  assert(desk.config.todos[0].text[0] && desk.revision == revision);
  Preferences::failWrites = false;
  Desk deskRebooted;
  deskRebooted.begin();
  assert(std::string(deskRebooted.config.todos[0].text) == "喝水");
  assert(deskRebooted.config.todos[1].dismissed);
  assert(deskRebooted.epoch == 0 && deskRebooted.alarm() == -1); // No guessed time after power loss.
  command("WIFI CLEAR");
  Desk afterWifiClear;
  afterWifiClear.begin();
  assert(std::string(afterWifiClear.config.city) == savedDesk.city);
  assert(std::string(afterWifiClear.config.todos[0].text) == "喝水");
  // Maximum-size escaping still fits serial/HTTP status and fails safely in small buffers.
  std::string escapedHex;
  for (int i = 0; i < 72; ++i) escapedHex += i % 2 ? "5c" : "22";
  for (int i = 0; i < DESK_TODOS; ++i) assert(command("DESK TODO " + std::to_string(i) + " 0 " + escapedHex).find("OK DESK") == 0);
  char full[4096], tiny[32];
  assert(formatStatus(full, sizeof(full)) && !formatStatus(tiny, sizeof(tiny)));
  assert(command("DESK TODO 0 0 " + escapedHex + "41").find("ERR ") == 0);
  command("WIFI CONNECT"); // Reprovision since CLEAR removed credentials.
  command("WIFI SET 4465736b 70617373776f7264");
  WiFi.currentStatus = WL_CONNECTED;
  loop(); httpControl.service();
  request("/api/command", HTTP_POST, {{"command", "DESK PAGE 3"}});
  assert(web.statusCode == 200 && desk.config.page == 3 && web.body.find("OK DESK") != std::string::npos);
  request("/api/command", HTTP_POST, {{"command", "DESK DELETE 0"}});
  assert(web.statusCode == 200 && !desk.config.todos[0].text[0]);
  request("/api/command", HTTP_POST, {{"command", "DESK PAGE 9"}});
  assert(web.statusCode == 400 && desk.config.page == 3);
  request("/api/command", HTTP_POST, {{"command", "DESK PAGE 1\nOFF"}});
  assert(web.statusCode == 400 && desk.config.page == 3);
  request("/web/desk.mjs", HTTP_GET);
  assert(web.statusCode == 200);
  const auto beforeRefresh = desk.refresh;
  command("DESK REFRESH");
  assert(desk.refresh == beforeRefresh + 1);
  // Display settings survive reboot independently of existing version-1 todos.
  assert(command("DESK DISPLAY ssd1306-128x32 61").find("OK DESK") == 0);
  assert(screenStore.settings().model == 1 && screenStore.settings().address == 61);
  ScreenStore rebootedScreen; rebootedScreen.begin();
  assert(rebootedScreen.settings().model == 1 && rebootedScreen.settings().address == 61);
  for (const char* invalid : {"DESK DISPLAY tft 60", "DESK DISPLAY ssd1306-128x64 62", "DESK DISPLAY ssd1306-128x64 60 extra", "DESK DISPLAY ssd1306-128x64", "DESK DISPLAY"}) {
    assert(command(invalid).find("ERR ") == 0);
    assert(screenStore.settings().model == 1);
  }
  Preferences::failWrites = true;
  assert(command("DESK DISPLAY sh1106-128x64 60").find("ERR ") == 0);
  assert(screenStore.settings().model == 1);
  Preferences::failWrites = false;
  request("/api/screen", HTTP_GET);
  assert(web.statusCode == 503 && web.body.find("screen_not_ready") != std::string::npos);
  uint8_t pixels[1024] = {}; pixels[0] = 0x81; pixels[511] = 0x80;
  screenStore.publish(screenStore.settings(), pixels, 100, 3, false);
  request("/api/screen", HTTP_GET);
  assert(web.statusCode == 200 && web.body.find("\"pixels\":\"81") != std::string::npos);
  assert(web.body.find("\"height\":32") != std::string::npos && web.body.find("\"present\":false") != std::string::npos);
  assert(screenStore.latest().checksum == screenChecksum(pixels, 512));
  assert(!screenStore.format(tiny, sizeof(tiny)));
  // Concurrent snapshots must never combine metadata/checksum from another frame.
  auto publisher = std::async(std::launch::async, [&]() {
    uint8_t bytes[1024];
    for (int i = 0; i < 500; ++i) { memset(bytes, i & 255, sizeof(bytes)); screenStore.publish(screenStore.settings(), bytes, i, 1, false); }
  });
  for (int i = 0; i < 500; ++i) {
    const auto frame = screenStore.latest();
    assert(frame.checksum == screenChecksum(frame.pixels, SCREEN_MODELS[frame.config.model].height * 16));
  }
  publisher.get();
  reportStatus(); assert(Serial.output.find("SCREEN ") != std::string::npos);
  std::cout << "Firmware: effects, Wi-Fi, HTTP and persistent desk/reminders passed\n";
}

/* USB / LAN HTTP LED controller. Commands and limits: see README.md. */
#include <Arduino.h>
#include <ctype.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include "effects.h"
#include "network.h"
#include "desk_runtime.h"

#define LED_PIN 2
#define LED_ACTIVE_LOW false

Effect effect;
uint32_t effectStart = 0;
uint32_t lastReport = 0;
int lastDuty = -1;

void applyOutput(uint32_t now) {
  const int duty = effectDuty(effect, uint32_t(now - effectStart));
  if (duty != lastDuty) {
    analogWrite(LED_PIN, LED_ACTIVE_LOW ? 255 - duty : duty);
    lastDuty = duty;
  }
}

bool formatStatus(char* output, size_t capacity) {
  const uint32_t now = millis();
  applyOutput(now);
  StatusJsonBuffer json(output, capacity);
  json.add("{\"version\":2,\"mode\":\"%s\",\"brightness\":%d,"
                "\"on_ms\":%lu,\"off_ms\":%lu,\"breathe_ms\":%lu,\"sos_unit_ms\":%lu,"
                "\"elapsed_ms\":%lu,\"uptime_ms\":%lu,\"led_duty\":%d,\"pin\":%d",
                modeName(effect.mode), effect.brightness,
                (unsigned long)effect.onMs, (unsigned long)effect.offMs,
                (unsigned long)effect.breatheMs, (unsigned long)effect.sosUnitMs,
                (unsigned long)(now - effectStart), (unsigned long)now, lastDuty, LED_PIN);
  network.appendStatus(json);
  desk.appendStatus(json);
  screenStore.appendStatus(json);
  json.add("}");
  return json.valid;
}

void reportStatus() {
  char output[4096];
  if (formatStatus(output, sizeof(output))) Serial.printf("STATUS %s\n", output);
  if (screenStore.format(output, sizeof(output)) && Serial.availableForWrite() >= int(strlen(output) + 9)) Serial.printf("SCREEN %s\n", output);
  lastReport = millis();
}

bool parseNumber(const char* token, int low, int high, int& result) {
  if (!token || !*token) return false;
  errno = 0;
  char* end;
  const long value = strtol(token, &end, 10);
  if (*end || errno == ERANGE) return false;
  result = value < low ? low : value > high ? high : int(value);
  return true;
}

bool executeEffectCommand(char* line, char* reply, size_t capacity) {
  // HTTP accepts one LED command, never embedded newlines or Wi-Fi credentials.
  if (strchr(line, '\n') || strchr(line, '\r')) return false;
  char* cursor;
  char* command = strtok_r(line, " \t", &cursor);
  if (!command) return false;
  for (char* c = command; *c; ++c) *c = toupper((unsigned char)*c);
  char* first = strtok_r(nullptr, " \t", &cursor);
  char* second = strtok_r(nullptr, " \t", &cursor);
  char* extra = strtok_r(nullptr, " \t", &cursor);
  int a = 0, b = 0;
  bool resetPhase = true;

  if (!strcmp(command, "STATUS") && !first) {
    snprintf(reply, capacity, "STATUS");
    return true;
  } else if (!strcmp(command, "PING") && !first) {
    snprintf(reply, capacity, "PONG");
    return true;
  } else if (!strcmp(command, "ON") && !first) {
    effect.mode = MODE_ON;
  } else if (!strcmp(command, "OFF") && !first) {
    effect.mode = MODE_OFF;
  } else if (!strcmp(command, "BLINK") && !extra &&
             parseNumber(first, 10, 60000, a) && parseNumber(second, 10, 60000, b)) {
    effect.onMs = a;
    effect.offMs = b;
    effect.mode = MODE_BLINK;
  } else if (!strcmp(command, "BRIGHT") && !second && parseNumber(first, 0, 255, a)) {
    effect.brightness = a;
    resetPhase = false;
  } else if (!strcmp(command, "BREATHE") && !second && parseNumber(first, 200, 60000, a)) {
    effect.breatheMs = a;
    effect.mode = MODE_BREATHE;
  } else if (!strcmp(command, "SOS") && !second && parseNumber(first, 50, 2000, a)) {
    effect.sosUnitMs = a;
    effect.mode = MODE_SOS;
  } else {
    return false;
  }

  if (resetPhase) effectStart = millis();
  applyOutput(millis());
  if (!strcmp(command, "BLINK")) snprintf(reply, capacity, "OK BLINK %d %d", a, b);
  else if (first) snprintf(reply, capacity, "OK %s %d", command, a);
  else snprintf(reply, capacity, "OK %s", command);
  return true;
}

bool executeControlCommand(char* line, char* reply, size_t capacity) {
  const char* p = line;
  while (*p == ' ' || *p == '\t') ++p;
  if (!strncasecmp(p, "DESK", 4) && (p[4] == ' ' || p[4] == '\t' || !p[4])) return executeDeskCommand(line, reply, capacity);
  return executeEffectCommand(line, reply, capacity);
}

void processCommand(char* line) {
  char copy[256];
  snprintf(copy, sizeof(copy), "%s", line);
  char* cursor;
  char* command = strtok_r(copy, " \t", &cursor);
  if (!command) return;
  for (char* c = command; *c; ++c) *c = toupper((unsigned char)*c);
  if (!strcmp(command, "WIFI")) {
    if (!network.command(cursor)) Serial.println("ERR invalid Wi-Fi command or arguments");
    reportStatus();
    return;
  }
  char reply[64];
  if (!executeControlCommand(line, reply, sizeof(reply))) { Serial.println("ERR invalid command or arguments"); return; }
  if (strcmp(reply, "STATUS")) Serial.println(reply);
  if (strcmp(reply, "PONG")) reportStatus();
}

#include "http_control.h"

void handleSerial() {
  static char line[256];
  static size_t length = 0;
  static bool overflow = false;
  // Bound each pass so sustained input cannot starve the LED animation.
  for (int count = 0; count < 128 && Serial.available(); ++count) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (overflow) Serial.println("ERR command too long");
      else if (length) {
        line[length] = '\0';
        processCommand(line);
      }
      memset(line, 0, sizeof(line));
      length = 0;
      overflow = false;
    } else if (!overflow) {
      if ((unsigned char)c < 32 && c != '\t') overflow = true;
      else if (length < sizeof(line) - 1) line[length++] = c;
      else overflow = true;
    }
  }
}

void setup() {
  Serial.setTxBufferSize(8192);
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  effectStart = millis();
  applyOutput(millis());
  network.begin();
  desk.begin();
  deskRuntime.begin();
  httpControl.begin();
  Serial.println("ESP32 LED control ready v2 + Wi-Fi HTTP");
  reportStatus();
}

void loop() {
  handleSerial();
  applyOutput(millis());
  network.tick(millis());
  deskRuntime.tick();
  httpControl.tick();
  if (uint32_t(millis() - lastReport) >= 1000) reportStatus();
  delay(1);
}

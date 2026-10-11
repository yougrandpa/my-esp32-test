#include <cassert>
#include <iostream>
#include <vector>
#include "../esp32_led_control/esp32_led_control.ino"

std::string command(const std::string& text) {
  Serial.output.clear();
  for (char c : text + "\n") Serial.input.push_back(c);
  while (Serial.available()) handleSerial();
  return Serial.output;
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
  assert(command(std::string(100, 'X')) == "ERR command too long\n");
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
  std::cout << "Firmware: breathing, Morse timing, parser, feedback and rollover passed\n";
}

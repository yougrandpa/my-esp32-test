#pragma once
#include <U8g2lib.h>
#include <time.h>
#include "desk.h"

// All composition lives in the device renderer. The browser only copies these
// pixels, including the compact layout, icons, clipping and text pagination.
class DeskUi {
 public:
  U8G2& s;
  explicit DeskUi(U8G2& screen) : s(screen) {}
  void text(int x, int y, const char* value) {
    s.setFont(u8g2_font_wqy12_t_gb2312);
    s.drawUTF8(x, y, value);
  }
  void small(int x, int y, const char* value) {
    s.setFont(u8g2_font_5x7_tr);
    s.drawStr(x, y, value);
  }
  void clipped(int x, int y, int width, const char* value) {
    s.setClipWindow(x, 0, x + width, s.getDisplayHeight());
    text(x, y, value);
    s.setMaxClipWindow();
  }
  const char* condition(int code) {
    if (code == 0) return "晴";
    if (code >= 1 && code <= 3) return "多云";
    if (code == 45 || code == 48) return "雾";
    if (code >= 95) return "雷雨";
    if ((code >= 71 && code <= 77) || code == 85 || code == 86) return "雪";
    if (code >= 51 && code <= 82) return "雨";
    return "未知";
  }
  void pin(int x, int y) {
    s.drawCircle(x + 3, y + 3, 3);
    s.drawPixel(x + 3, y + 3);
    s.drawLine(x + 1, y + 6, x + 3, y + 9);
    s.drawLine(x + 3, y + 9, x + 5, y + 6);
  }
  void check(int x, int y) {
    s.drawLine(x, y + 3, x + 3, y + 6);
    s.drawLine(x + 3, y + 6, x + 8, y);
  }
  void bell(int x, int y) {
    s.drawRFrame(x + 1, y + 2, 7, 6, 2);
    s.drawHLine(x, y + 8, 9);
    s.drawPixel(x + 4, y); s.drawPixel(x + 4, y + 10);
  }
  void clock(int x, int y) {
    s.drawCircle(x + 3, y + 3, 3);
    s.drawVLine(x + 3, y + 1, 3);
    s.drawHLine(x + 3, y + 3, 3);
  }
  void network(bool live) {
    for (int i = 0; i < 3; ++i) {
      if (live) s.drawBox(114 + i * 4, 10 - i * 2, 2, 2 + i * 2);
      else s.drawPixel(115 + i * 4, 10);
    }
  }
  void header(const char* label, int page, const char* right, bool live, bool compact) {
    if (page == 4) {
      s.drawRBox(2, 0, 76, 14, 2); s.setDrawColor(0);
      bell(6, 2); text(19, 11, label); s.setDrawColor(1);
    } else {
      if (page == 3) check(4, 4); else pin(4, 2);
      clipped(17, 11, right ? 75 : 92, label);
    }
    if (right) {
      s.setFont(u8g2_font_5x7_tr);
      s.drawStr(124 - s.getStrWidth(right), 10, right);
    } else network(live);
    s.drawHLine(4, compact ? 13 : 15, 120);
  }
  void footer(int page) {
    s.drawHLine(4, 51, 120);
    for (int i = 1; i <= 3; ++i) {
      if (i == page) s.drawBox(110 + (i - 1) * 6, 58, 3, 3);
      else s.drawPixel(111 + (i - 1) * 6, 59);
    }
  }
  void sun(int x, int y, int r) {
    s.drawCircle(x, y, r);
    s.drawVLine(x, y - r - 4, 2); s.drawVLine(x, y + r + 3, 2);
    s.drawHLine(x - r - 4, y, 2); s.drawHLine(x + r + 3, y, 2);
    const int d = r + 2;
    s.drawLine(x - d, y - d, x - d + 1, y - d + 1);
    s.drawLine(x + d, y - d, x + d - 1, y - d + 1);
    s.drawLine(x - d, y + d, x - d + 1, y + d - 1);
    s.drawLine(x + d, y + d, x + d - 1, y + d - 1);
  }
  void cloud(int x, int y) {
    s.drawDisc(x + 7, y + 8, 5); s.drawDisc(x + 14, y + 5, 7);
    s.drawDisc(x + 22, y + 9, 5); s.drawBox(x + 7, y + 8, 16, 7);
    s.setDrawColor(0);
    s.drawDisc(x + 7, y + 8, 3); s.drawDisc(x + 14, y + 5, 5);
    s.drawDisc(x + 22, y + 9, 3); s.drawBox(x + 7, y + 8, 16, 5);
    s.setDrawColor(1);
  }
  void weatherIcon(int x, int y, int code) {
    if (code == 0) { sun(x + 14, y + 10, 5); return; }
    if (code == 1 || code == 2) sun(x + 7, y + 5, 4);
    cloud(x, y + 2);
    if (code == 45 || code == 48) {
      s.drawHLine(x + 4, y + 18, 23); s.drawHLine(x + 7, y + 20, 17);
    } else if (code >= 95) {
      s.drawLine(x + 15, y + 16, x + 11, y + 19);
      s.drawHLine(x + 11, y + 19, 6); s.drawLine(x + 16, y + 19, x + 13, y + 20);
    } else if ((code >= 71 && code <= 77) || code == 85 || code == 86) {
      for (int i = 0; i < 3; ++i) {
        int cx = x + 7 + i * 8;
        s.drawHLine(cx - 1, y + 19, 3); s.drawVLine(cx, y + 18, 3);
      }
    } else if (code >= 51 && code <= 82) {
      for (int i = 0; i < 3; ++i) s.drawLine(x + 8 + i * 7, y + 17, x + 6 + i * 7, y + 20);
    }
  }
  void compactWeatherIcon(int code) {
    if (code == 0) { sun(79, 23, 3); return; }
    s.drawCircle(79, 21, 3); s.drawCircle(75, 23, 2); s.drawCircle(83, 23, 2);
    s.setDrawColor(0); s.drawBox(75, 23, 9, 2); s.setDrawColor(1);
    s.drawHLine(75, 25, 9);
    if (code == 45 || code == 48) s.drawHLine(74, 28, 11);
    else if (code >= 51) {
      s.drawLine(77, 27, 76, 29); s.drawLine(82, 27, 81, 29);
    }
  }
  // Wrap without splitting UTF-8. The narrower checklist column still reveals
  // every saved character, two lines at a time (one on the compact screen).
  void itemText(const char* value, uint32_t step, bool compact) {
    s.setFont(u8g2_font_wqy12_t_gb2312);
    char lines[12][73] = {};
    int row = 0, pos = 0;
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(value); *p && row < 12;) {
      const int size = *p < 128 ? 1 : *p < 224 ? 2 : *p < 240 ? 3 : 4;
      char glyph[5] = {}; memcpy(glyph, p, size);
      char test[73]; snprintf(test, sizeof(test), "%s%s", lines[row], glyph);
      if (s.getUTF8Width(test) > 106 && pos) { ++row; pos = 0; if (row == 12) break; }
      memcpy(lines[row] + pos, glyph, size); pos += size; p += size;
    }
    const int groups = compact ? row + 1 : (row + 2) / 2;
    const int first = (step % groups) * (compact ? 1 : 2);
    s.drawFrame(4, compact ? 20 : 23, 8, 8);
    text(18, compact ? 30 : 33, lines[first]);
    if (!compact && first + 1 <= row) text(18, 47, lines[first + 1]);
  }
  void temperature(float value, bool compact) {
    char line[16]; snprintf(line, sizeof(line), "%.1f", value);
    s.setFont(compact ? u8g2_font_logisoso16_tn : u8g2_font_logisoso24_tn);
    if (s.getStrWidth(line) > (compact ? 55 : 66)) s.setFont(u8g2_font_logisoso16_tn);
    const int width = s.getStrWidth(line);
    s.drawStr(4, compact ? 31 : 44, line);
    const int top = compact ? 18 : 22;
    s.drawCircle(7 + width, top, 1);
    small(10 + width, top + 6, "C");
  }
  void forecast(const DeskForecast& day) {
    char line[24]; snprintf(line, sizeof(line), "%s", day.date + 5);
    line[2] = '/'; small(4, 62, line);
    // Down/up arrows distinguish minimum and maximum without verbose labels.
    s.drawVLine(38, 56, 6); s.drawLine(36, 59, 38, 61); s.drawLine(40, 59, 38, 61);
    snprintf(line, sizeof(line), "%.0f", day.low); small(44, 62, line);
    s.drawVLine(70, 56, 6); s.drawLine(68, 58, 70, 56); s.drawLine(72, 58, 70, 56);
    snprintf(line, sizeof(line), "%.0f", day.high); small(76, 62, line);
    if (day.code == 0) {
      s.drawCircle(100, 58, 2);
      s.drawPixel(100, 54); s.drawPixel(100, 62); s.drawPixel(96, 58); s.drawPixel(104, 58);
    } else {
      s.drawCircle(98, 58, 2); s.drawCircle(101, 56, 2); s.drawCircle(103, 58, 2);
      s.setDrawColor(0); s.drawBox(98, 58, 6, 2); s.setDrawColor(1); s.drawHLine(98, 60, 6);
      if (day.code >= 51) { s.drawPixel(99, 62); s.drawPixel(103, 62); }
    }
  }
  int draw(const DeskConfig& c, const DeskWeather& w, bool live, bool compact, uint32_t now, time_t epoch) {
    const time_t local = epoch + c.offset * 60;
    tm parts{}; gmtime_r(&local, &parts);
    const bool ready = epoch >= 1704067200;
    int alarm = -1, active[DESK_TODOS], count = 0;
    for (int i = 0; i < DESK_TODOS; ++i) {
      const auto& t = c.todos[i];
      if (!t.text[0] || t.done) continue;
      active[count++] = i;
      if (ready && t.due && t.due <= epoch && !t.dismissed && (alarm < 0 || t.due < c.todos[alarm].due)) alarm = i;
    }
    const int page = alarm >= 0 ? 4 : deskPageAt(c, now);
    char line[48], timeLabel[8];
    if (ready) strftime(timeLabel, sizeof(timeLabel), "%H:%M", &parts);
    else snprintf(timeLabel, sizeof(timeLabel), "--:--");
    s.clearBuffer(); s.setDrawColor(1); s.setMaxClipWindow();
    if (page == 1) {
      header(c.city, page, nullptr, live, compact);
      s.setFont(compact ? u8g2_font_logisoso16_tn : u8g2_font_logisoso24_tn);
      const int width = s.getStrWidth(timeLabel);
      s.drawStr(compact ? 4 : (96 - width) / 2, compact ? 31 : 44, timeLabel);
      if (ready) strftime(line, sizeof(line), "%S", &parts); else snprintf(line, sizeof(line), "--");
      if (compact) {
        small(60, 30, line);
        if (ready) { strftime(line, sizeof(line), "%m/%d", &parts); small(96, 28, line); }
      } else {
        s.drawRFrame(98, 27, 26, 19, 2);
        s.setFont(u8g2_font_logisoso16_tn);
        s.drawStr(98 + (26 - s.getStrWidth(line)) / 2, 44, line);
        footer(page);
        if (ready) {
          strftime(line, sizeof(line), "%Y/%m/%d", &parts); small(4, 62, line);
          const char* weekdays[] = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};
          text(68, 63, weekdays[parts.tm_wday]);
        } else text(4, 63, "等待校时");
      }
    } else if (page == 2) {
      header(c.city, page, timeLabel, live, compact);
      if (!compact) footer(page);
      if (!w.valid) {
        if (compact) text(4, 30, live ? "正在获取天气" : "请先连接 Wi-Fi");
        else {
          cloud(49, 22);
          text(28, 48, live ? "正在获取天气" : "等待网络连接");
          small(4, 62, w.error[0] ? "RETRYING" : live ? "SYNCING" : "OFFLINE");
        }
      } else {
        const int day = deskRotationAt(c, now, 8000, 3);
        const bool stale = !live || w.error[0] || epoch - w.updated > 3600;
        if (compact) {
          if (now / 4000 % 2 == 0) { temperature(w.temperature, true); compactWeatherIcon(w.code); clipped(91, 30, 33, condition(w.code)); }
          else {
            snprintf(line, sizeof(line), "%s %.0f~%.0f", w.days[day].date + 5, w.days[day].low, w.days[day].high);
            small(4, 27, line); clipped(91, 30, 33, condition(w.days[day].code));
          }
        } else {
          temperature(w.temperature, false);
          weatherIcon(92, 18, w.code);
          s.setFont(u8g2_font_wqy12_t_gb2312);
          s.drawUTF8(106 - s.getUTF8Width(condition(w.code)) / 2, 49, condition(w.code));
          forecast(w.days[day]);
        }
        // Hollow marker means cached/offline weather; no fake live indicator.
        if (stale) s.drawFrame(86, compact ? 17 : 19, 3, 3);
      }
    } else {
      const int index = deskRotationAt(c, now, 12000, count);
      snprintf(line, sizeof(line), "%d/%d", count ? index + 1 : 0, count);
      header(page == 4 ? "到点提醒" : "待办", page, page == 4 ? timeLabel : line, live, compact);
      if (!compact) footer(page);
      if (!count) {
        if (compact) { check(4, 22); text(18, 30, "已全部完成"); }
        else { s.drawCircle(17, 33, 10); check(13, 30); text(34, 38, "已全部完成"); small(4, 62, "ALL CLEAR"); }
      } else {
        const auto& t = c.todos[page == 4 ? alarm : active[index]];
        const uint32_t within = now % (c.page ? 12000u : 8000u);
        if (compact && page != 4 && t.due && within >= (c.page ? 8000u : 6000u)) {
          time_t due = t.due + c.offset * 60; tm date{}; gmtime_r(&due, &date);
          strftime(line, sizeof(line), "%m/%d %H:%M", &date); clock(4, 22); small(18, 28, line);
        } else {
          // Resume long text on the next visit to this item. Restarting at line
          // one on every automatic page would hide the end of long ASCII text.
          const uint32_t stepsPerVisit = compact && t.due ? 2 : c.page ? 3 : 2;
          const uint32_t visits = now / (c.page ? 12000u : 24000u) / count;
          const uint32_t step = page == 4 ? now / 4000 : visits * stepsPerVisit + within / 4000;
          itemText(t.text, step, compact);
        }
        if (!compact) {
          if (page == 4) { bell(4, 53); text(18, 63, "请在网页确认"); }
          else if (t.due) {
            time_t due = t.due + c.offset * 60; tm date{}; gmtime_r(&due, &date);
            strftime(line, sizeof(line), "%m/%d %H:%M", &date); clock(4, 56); small(16, 62, line);
          } else { clock(4, 56); small(16, 62, "NO DUE DATE"); }
        }
      }
    }
    return page;
  }
};

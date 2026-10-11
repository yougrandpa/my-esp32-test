#pragma once
#include <map>
#include <functional>
#include <string>

enum HTTPMethod { HTTP_GET, HTTP_POST };
class WebServer {
 public:
  using Handler = std::function<void()>;
  std::map<std::pair<std::string, HTTPMethod>, Handler> routes;
  std::map<std::string, std::string> requestArgs, headers, responseHeaders;
  Handler missing;
  Handler handleClientHook;
  int statusCode = 0, starts = 0, stops = 0;
  std::string body, mime, host = "192.168.1.42";
  explicit WebServer(int) {}
  void on(const char* path, HTTPMethod method, Handler handler) { routes[{path, method}] = handler; }
  void onNotFound(Handler handler) { missing = handler; }
  void collectHeaders(const char*[], size_t) {}
  std::string header(const char* key) { return headers[key]; }
  std::string hostHeader() { return host; }
  bool hasArg(const char* key) { return requestArgs.count(key); }
  int args() { return requestArgs.size(); }
  std::string arg(const char* key) { return requestArgs[key]; }
  void sendHeader(const char* key, const char* value) { responseHeaders[key] = value; }
  void send(int code, const char* type, const char* value) { statusCode = code; mime = type; body = value; }
  void send_P(int code, const char* type, const char* value, size_t length) { statusCode = code; mime = type; body.assign(value, length); }
  void begin() { ++starts; }
  void stop() { ++stops; }
  void handleClient() { if (handleClientHook) handleClientHook(); }
  void request(const char* path, HTTPMethod method, std::map<std::string, std::string> values = {}) {
    requestArgs = values;
    responseHeaders.clear();
    const auto found = routes.find({path, method});
    if (found == routes.end()) missing();
    else found->second();
  }
};

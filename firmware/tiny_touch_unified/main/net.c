#include "net.h"

#include <string.h>
#include <time.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "mqtt_client.h"
#include "nvs.h"

static const char *TAG = "net";

#define NET_SSID_CAP 33
#define NET_PSK_CAP 65
#define NET_URI_CAP 128
#define NET_TOPIC_CAP 64

static char wifi_ssid[NET_SSID_CAP];
static char wifi_psk[NET_PSK_CAP];
static char mqtt_uri[NET_URI_CAP];
static char mqtt_topic[NET_TOPIC_CAP] = "tinytouch";

static bool netif_ready;
static bool wifi_started;
static bool wifi_connected;
static bool sntp_started;
static bool time_valid;
static esp_mqtt_client_handle_t mqtt_client;
static bool mqtt_connected;

static void load_config(void) {
  wifi_ssid[0] = '\0';
  wifi_psk[0] = '\0';
  mqtt_uri[0] = '\0';
  strlcpy(mqtt_topic, "tinytouch", sizeof(mqtt_topic));
  nvs_handle_t handle;
  if (nvs_open("net", NVS_READONLY, &handle) != ESP_OK) return;
  size_t length = sizeof(wifi_ssid);
  nvs_get_str(handle, "ssid", wifi_ssid, &length);
  length = sizeof(wifi_psk);
  nvs_get_str(handle, "psk", wifi_psk, &length);
  length = sizeof(mqtt_uri);
  nvs_get_str(handle, "mqtt_uri", mqtt_uri, &length);
  length = sizeof(mqtt_topic);
  nvs_get_str(handle, "mqtt_topic", mqtt_topic, &length);
  if (mqtt_topic[0] == '\0') strlcpy(mqtt_topic, "tinytouch", sizeof(mqtt_topic));
  nvs_close(handle);
}

static void build_topic(char *out, size_t cap, const char *leaf) {
  snprintf(out, cap, "%s/%s", mqtt_topic, leaf);
}

static void mqtt_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)base;
  (void)data;
  switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED: {
      mqtt_connected = true;
      char topic[NET_TOPIC_CAP + 16];
      build_topic(topic, sizeof(topic), "status");
      esp_mqtt_client_publish(mqtt_client, topic, "online", 0, 1, true);
      ESP_LOGI(TAG, "mqtt connected");
      break;
    }
    case MQTT_EVENT_DISCONNECTED:
      mqtt_connected = false;
      break;
    default:
      break;
  }
}

static void start_mqtt(void) {
  if (mqtt_client || mqtt_uri[0] == '\0') return;
  char lwt_topic[NET_TOPIC_CAP + 16];
  build_topic(lwt_topic, sizeof(lwt_topic), "status");
  esp_mqtt_client_config_t config = {
    .broker.address.uri = mqtt_uri,
    .session.last_will.topic = lwt_topic,
    .session.last_will.msg = "offline",
    .session.last_will.msg_len = 7,
    .session.last_will.qos = 1,
    .session.last_will.retain = true,
  };
  mqtt_client = esp_mqtt_client_init(&config);
  if (!mqtt_client) {
    ESP_LOGW(TAG, "mqtt init failed");
    return;
  }
  esp_mqtt_client_register_event(mqtt_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
  esp_mqtt_client_start(mqtt_client);
}

static void sntp_synced(struct timeval *tv) {
  (void)tv;
  time_valid = true;
  ESP_LOGI(TAG, "time synchronized");
}

static void start_sntp(void) {
  if (sntp_started) return;
  esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
  config.sync_cb = sntp_synced;
  if (esp_netif_sntp_init(&config) == ESP_OK) sntp_started = true;
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
  (void)arg;
  (void)data;
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
    esp_wifi_connect();
  } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_connected = false;
    mqtt_connected = false;
    esp_wifi_connect();
  } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    wifi_connected = true;
    ESP_LOGI(TAG, "wifi got ip");
    start_sntp();
    start_mqtt();
  }
}

static void start_wifi(void) {
  if (wifi_started || wifi_ssid[0] == '\0') return;

  if (!netif_ready) {
    if (esp_netif_init() != ESP_OK) return;
    esp_err_t loop = esp_event_loop_create_default();
    if (loop != ESP_OK && loop != ESP_ERR_INVALID_STATE) return;
    esp_netif_create_default_wifi_sta();
    netif_ready = true;
  }

  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  if (esp_wifi_init(&init) != ESP_OK) return;
  esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                      wifi_event_handler, NULL, NULL);
  esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                      wifi_event_handler, NULL, NULL);

  wifi_config_t config = {0};
  strlcpy((char *)config.sta.ssid, wifi_ssid, sizeof(config.sta.ssid));
  strlcpy((char *)config.sta.password, wifi_psk, sizeof(config.sta.password));
  config.sta.threshold.authmode =
    wifi_psk[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

  esp_wifi_set_mode(WIFI_MODE_STA);
  esp_wifi_set_config(WIFI_IF_STA, &config);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (esp_wifi_start() != ESP_OK) return;
  wifi_started = true;
  ESP_LOGI(TAG, "wifi station started for ssid=%s", wifi_ssid);
}

void net_init(void) {
  load_config();
  start_wifi();
}

void net_reload(void) {
  // Credentials changed. A full teardown of the Wi-Fi/MQTT stack mid-run is
  // fiddly and error-prone; a reboot is the clean, predictable path and the
  // config console reboots after provisioning anyway.
  load_config();
  if (!wifi_started) start_wifi();
}

bool net_set_wifi(const char *ssid, const char *password) {
  if (!ssid || strlen(ssid) >= NET_SSID_CAP) return false;
  if (password && strlen(password) >= NET_PSK_CAP) return false;
  nvs_handle_t handle;
  if (nvs_open("net", NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t result = nvs_set_str(handle, "ssid", ssid);
  if (result == ESP_OK) result = nvs_set_str(handle, "psk", password ? password : "");
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result == ESP_OK;
}

bool net_set_mqtt(const char *uri, const char *topic_prefix) {
  if (!uri || strlen(uri) >= NET_URI_CAP) return false;
  if (topic_prefix && strlen(topic_prefix) >= NET_TOPIC_CAP) return false;
  nvs_handle_t handle;
  if (nvs_open("net", NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t result = nvs_set_str(handle, "mqtt_uri", uri);
  if (result == ESP_OK) {
    result = nvs_set_str(handle, "mqtt_topic",
                         (topic_prefix && topic_prefix[0]) ? topic_prefix : "tinytouch");
  }
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  return result == ESP_OK;
}

void net_publish_event(uint16_t slot, bool success) {
  if (!mqtt_client || !mqtt_connected) return;
  char topic[NET_TOPIC_CAP + 16];
  build_topic(topic, sizeof(topic), "event");
  char payload[96];
  int len = snprintf(payload, sizeof(payload),
                     "{\"slot\":%u,\"result\":\"%s\",\"ts\":%lld}",
                     slot, success ? "match" : "reject",
                     (long long)time(NULL));
  // enqueue (non-blocking) so a slow broker never stalls the auth loop
  esp_mqtt_client_enqueue(mqtt_client, topic, payload, len, 0, false, true);
}

void net_status(char *out, size_t cap) {
  snprintf(out, cap, "wifi=%s%s mqtt=%s",
           wifi_ssid[0] ? "configured" : "unconfigured",
           wifi_connected ? "/up" : (wifi_started ? "/down" : ""),
           mqtt_uri[0] == '\0' ? "unconfigured"
                               : (mqtt_connected ? "connected" : "configured"));
}

bool net_time_valid(void) {
  return time_valid;
}

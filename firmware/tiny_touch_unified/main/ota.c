#include "ota.h"

#include <string.h>

#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

static const char *TAG = "ota";
#define OTA_URL_CAP 200

static char ota_url[OTA_URL_CAP];
static volatile bool ota_busy;
static char last_result[48] = "idle";

static void load_url(void) {
  ota_url[0] = '\0';
  nvs_handle_t handle;
  if (nvs_open("ota", NVS_READONLY, &handle) != ESP_OK) return;
  size_t length = sizeof(ota_url);
  nvs_get_str(handle, "url", ota_url, &length);
  nvs_close(handle);
}

void ota_init(void) {
  load_url();
  // Rollback is enabled: a freshly OTA'd image boots PENDING_VERIFY and must be
  // confirmed or it reverts on the next reset. Reaching here means core init
  // (NVS, sensor, USB) succeeded, so mark the running slot valid.
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
      state == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "OTA image confirmed valid");
  }
}

static void ota_task(void *arg) {
  (void)arg;
  esp_http_client_config_t http = {
    .url = ota_url,
    .crt_bundle_attach = esp_crt_bundle_attach,
    .timeout_ms = 20000,
    .keep_alive_enable = true,
  };
  esp_https_ota_config_t config = {.http_config = &http};
  ESP_LOGI(TAG, "starting OTA from %s", ota_url);
  esp_err_t result = esp_https_ota(&config);
  if (result == ESP_OK) {
    strlcpy(last_result, "success_rebooting", sizeof(last_result));
    ESP_LOGW(TAG, "OTA succeeded; rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
  } else {
    snprintf(last_result, sizeof(last_result), "failed:0x%x", result);
    ESP_LOGE(TAG, "OTA failed: 0x%x", result);
  }
  ota_busy = false;
  vTaskDelete(NULL);
}

bool ota_set_url(const char *url) {
  if (!url || strlen(url) >= OTA_URL_CAP) return false;
  nvs_handle_t handle;
  if (nvs_open("ota", NVS_READWRITE, &handle) != ESP_OK) return false;
  esp_err_t result = nvs_set_str(handle, "url", url);
  if (result == ESP_OK) result = nvs_commit(handle);
  nvs_close(handle);
  if (result == ESP_OK) strlcpy(ota_url, url, sizeof(ota_url));
  return result == ESP_OK;
}

bool ota_check(void) {
  if (ota_busy || ota_url[0] == '\0') return false;
  ota_busy = true;
  strlcpy(last_result, "running", sizeof(last_result));
  if (xTaskCreate(ota_task, "ota", 8192, NULL, 5, NULL) != pdPASS) {
    ota_busy = false;
    strlcpy(last_result, "task_failed", sizeof(last_result));
    return false;
  }
  return true;
}

void ota_status(char *out, size_t cap) {
  const esp_app_desc_t *desc = esp_app_get_description();
  snprintf(out, cap, "url=%s running=%s state=%s",
           ota_url[0] ? "configured" : "unconfigured",
           desc->version, last_result);
}

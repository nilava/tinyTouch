#pragma once

#include <stdbool.h>
#include <stddef.h>

// Optional over-the-air updates via esp_https_ota. The update URL is stored in
// NVS (set over the config console / web page). Nothing runs unless explicitly
// triggered, and the running slot is only marked valid after a healthy boot, so
// a bad image rolls back on the next reset.

void ota_init(void);                       // confirm current app, mark valid
bool ota_set_url(const char *url);         // persist the HTTPS image URL
bool ota_check(void);                       // start an update (async); false if busy/unconfigured
void ota_status(char *out, size_t cap);

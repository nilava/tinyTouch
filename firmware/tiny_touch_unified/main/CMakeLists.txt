idf_component_register(
  SRCS
    "main.c"
    "config_console.c"
    "device_config.c"
    "fingerprint.c"
    "piv.c"
    "touch_pin_hid.c"
    "usb_ccid.c"
    "usb_descriptors.c"
    "net.c"
  INCLUDE_DIRS "."
  REQUIRES driver esp_timer esp_tinyusb mbedtls nvs_flash
            esp_wifi esp_event esp_netif esp-tls mqtt lwip
)

if(TINYTOUCH_RECOVERY_BUILD)
  target_compile_definitions(${COMPONENT_LIB} PRIVATE TINYTOUCH_RECOVERY_BUILD=1)
endif()

target_compile_definitions(
  ${COMPONENT_LIB} PRIVATE
  TINYTOUCH_FIRMWARE_VERSION="${TINYTOUCH_VERSION}"
  TINYTOUCH_PROTOCOL_VERSION=2
)

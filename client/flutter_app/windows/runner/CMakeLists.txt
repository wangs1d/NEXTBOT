cmake_minimum_required(VERSION 3.14)
project(runner LANGUAGES CXX)

# WebView2 is provided by the webview_windows plugin only. Do NOT link
# WebView2LoaderStatic into the runner EXE — two loaders in one process
# cause STATUS_STACK_BUFFER_OVERRUN (0xC0000409) when the desk overlay starts.

# Define the application target. To change its name, change BINARY_NAME in the
# top-level CMakeLists.txt, not the value here, or `flutter run` will no longer
# work.
#
# Any new source files that you add to the application should be added here.
add_executable(${BINARY_NAME} WIN32
  "agent_profile_overlay_window.cpp"
  "connected_call_window.cpp"
  "desktop_notification_window.cpp"
  "desktop_screen_capture.cpp"
  "flutter_window.cpp"
  "glass_notify_window.cpp"
  "incoming_call_window.cpp"
  "main.cpp"
  "outgoing_call_window.cpp"
  "dynamic_island_window.cpp"
  "pcm_stream_player.cpp"
  "sphere_overlay_window.cpp"
  "utils.cpp"
  "webview_ghost_window_guardian.cpp"
  "win32_window.cpp"
  "${FLUTTER_MANAGED_DIR}/generated_plugin_registrant.cc"
  "Runner.rc"
  "runner.exe.manifest"
)

# Apply the standard set of build settings. This can be removed for applications
# that need different build settings.
apply_standard_settings(${BINARY_NAME})

# Add preprocessor definitions for the build version.
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION=\"${FLUTTER_VERSION}\"")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MAJOR=${FLUTTER_VERSION_MAJOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MINOR=${FLUTTER_VERSION_MINOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_PATCH=${FLUTTER_VERSION_PATCH}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_BUILD=${FLUTTER_VERSION_BUILD}")

# Disable Windows macros that collide with C++ standard library functions.
target_compile_definitions(${BINARY_NAME} PRIVATE "NOMINMAX")

# Add dependency libraries and include directories. Add any application-specific
# dependencies here.
target_link_libraries(${BINARY_NAME} PRIVATE flutter flutter_wrapper_app)
target_link_libraries(${BINARY_NAME} PRIVATE "dwmapi.lib" "gdiplus.lib" "ole32.lib" "winmm.lib")
target_include_directories(${BINARY_NAME} PRIVATE "${CMAKE_SOURCE_DIR}")

# Run the Flutter tool portions of the build. This must not be removed.
add_dependencies(${BINARY_NAME} flutter_assemble)

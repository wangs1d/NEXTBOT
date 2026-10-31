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
  "desktop_screen_capture.cpp"
  "flutter_window.cpp"
  "glass_notify_window.cpp"
  "incoming_call_window.cpp"
  "main.cpp"
  "outgoing_call_window.cpp"
  "dynamic_island_window.cpp"
  "pcm_stream_player.cpp"
  "single_instance.cpp"
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

# SMTC（系统媒体传输控件）采集：C++/WinRT 依赖异常，而 runner 全局
# _HAS_EXCEPTIONS=0，故单独编译为静态库，头文件只暴露纯标准库结构。
# 注意：Windows Kits 在 Program Files (x86)，而 CMake 的 $ENV{} 不接受含
# 括号的变量名，故注册表读路径 + 常见路径兜底。
set(_sdk_roots "")
get_filename_component(_pf86 "[HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion;ProgramFilesDir (x86)]" ABSOLUTE)
if(_pf86 AND IS_DIRECTORY "${_pf86}")
  list(APPEND _sdk_roots "${_pf86}/Windows Kits/10")
endif()
if(DEFINED ENV{ProgramFiles})
  list(APPEND _sdk_roots "$ENV{ProgramFiles}/Windows Kits/10")
endif()
list(APPEND _sdk_roots "C:/Program Files (x86)/Windows Kits/10")

set(CPPWINRT_INCLUDE_DIR "")
if(CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION)
  foreach(_root IN LISTS _sdk_roots)
    set(_probe "${_root}/Include/${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}/cppwinrt")
    if(EXISTS "${_probe}/winrt/base.h")
      set(CPPWINRT_INCLUDE_DIR "${_probe}")
      break()
    endif()
  endforeach()
endif()
if(NOT CPPWINRT_INCLUDE_DIR)
  foreach(_root IN LISTS _sdk_roots)
    file(GLOB _candidates LIST_DIRECTORIES true "${_root}/Include/*/cppwinrt")
    list(SORT _candidates)
    list(REVERSE _candidates)
    foreach(_candidate IN LISTS _candidates)
      if(EXISTS "${_candidate}/winrt/base.h")
        set(CPPWINRT_INCLUDE_DIR "${_candidate}")
        break()
      endif()
    endforeach()
    if(CPPWINRT_INCLUDE_DIR)
      break()
    endif()
  endforeach()
endif()
if(NOT CPPWINRT_INCLUDE_DIR)
  message(FATAL_ERROR "Windows SDK C++/WinRT headers not found (cppwinrt/winrt/base.h)")
endif()

add_library(media_session STATIC "media_session_watcher.cpp")
target_compile_features(media_session PUBLIC cxx_std_17)
target_compile_options(media_session PRIVATE /W4 /wd"4100" /utf-8 /EHsc)
target_include_directories(media_session PRIVATE "${CPPWINRT_INCLUDE_DIR}")
target_link_libraries(media_session PUBLIC "WindowsApp.lib")
target_link_libraries(${BINARY_NAME} PRIVATE media_session)

# Run the Flutter tool portions of the build. This must not be removed.
add_dependencies(${BINARY_NAME} flutter_assemble)

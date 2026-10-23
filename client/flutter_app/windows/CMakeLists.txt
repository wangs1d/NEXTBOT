# Project-level configuration.
cmake_minimum_required(VERSION 3.14)
project(nextbot LANGUAGES CXX)

# The name of the executable created for the application. Change this to change
# the on-disk name of your application.
set(BINARY_NAME "NEXTBOT")

# Explicitly opt in to modern CMake behaviors to avoid warnings with recent
# versions of CMake.
cmake_policy(VERSION 3.14...3.25)
# webview_windows (and similar plugins) use DEPENDS with add_custom_command(TARGET).
if(POLICY CMP0175)
  cmake_policy(SET CMP0175 OLD)
endif()

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/ensure_nuget.cmake")

# Define build configuration option.
get_property(IS_MULTICONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(IS_MULTICONFIG)
  set(CMAKE_CONFIGURATION_TYPES "Debug;Profile;Release"
    CACHE STRING "" FORCE)
else()
  if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Debug" CACHE
      STRING "Flutter build mode" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS
      "Debug" "Profile" "Release")
  endif()
endif()
# Define settings for the Profile build mode.
set(CMAKE_EXE_LINKER_FLAGS_PROFILE "${CMAKE_EXE_LINKER_FLAGS_RELEASE}")
set(CMAKE_SHARED_LINKER_FLAGS_PROFILE "${CMAKE_SHARED_LINKER_FLAGS_RELEASE}")
set(CMAKE_C_FLAGS_PROFILE "${CMAKE_C_FLAGS_RELEASE}")
set(CMAKE_CXX_FLAGS_PROFILE "${CMAKE_CXX_FLAGS_RELEASE}")

# Use Unicode for all projects.
add_definitions(-DUNICODE -D_UNICODE)
# MSVC 14.5x 对 <experimental/coroutine> 的废弃警告变成 error，webview_windows 插件还在用。
add_definitions(-D_SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS)

# Compilation settings that should be applied to most targets.
#
# Be cautious about adding new options here, as plugins use this function by
# default. In most cases, you should add new options to specific targets instead
# of modifying this function.
function(APPLY_STANDARD_SETTINGS TARGET)
  target_compile_features(${TARGET} PUBLIC cxx_std_17)
  # /utf-8: tell MSVC source files are UTF-8 so C4819 doesn't fire on Chinese
  # comments inside headers (and stop bogus "undeclared identifier" / "missing
  # type specifier" errors caused by mis-decoded bytes).
  target_compile_options(${TARGET} PRIVATE /W4 /WX /wd"4100" /utf-8)
  target_compile_options(${TARGET} PRIVATE /EHsc)
  # /FS: let mspdbsrv serialize PDB writes across parallel cl.exe instances.
  # Without it the geolocator_windows plugin hits MSVC C1041 ("cannot open
  # program database ... vc145.pdb") when its sources compile concurrently.
  target_compile_options(${TARGET} PRIVATE /FS)
  target_compile_definitions(${TARGET} PRIVATE "_HAS_EXCEPTIONS=0")
  target_compile_definitions(${TARGET} PRIVATE "$<$<CONFIG:Debug>:_DEBUG>")
endfunction()

# Flutter library and tool build rules.
set(FLUTTER_MANAGED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/flutter")
add_subdirectory(${FLUTTER_MANAGED_DIR})

# Application build; see runner/CMakeLists.txt.
add_subdirectory("runner")


# Generated plugin build rules, which manage building the plugins and adding
# them to the application.
include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/patch_webview_windows.cmake")
include(flutter/generated_plugins.cmake)


# === Installation ===
# Support files are copied into place next to the executable, so that it can
# run in place. This is done instead of making a separate bundle (as on Linux)
# so that building and running from within Visual Studio will work.
set(BUILD_BUNDLE_DIR "$<TARGET_FILE_DIR:${BINARY_NAME}>")
# Make the "install" step default, as it's required to run.
set(CMAKE_VS_INCLUDE_INSTALL_TO_DEFAULT_BUILD 1)
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
  set(CMAKE_INSTALL_PREFIX "${BUILD_BUNDLE_DIR}" CACHE PATH "..." FORCE)
endif()

set(INSTALL_BUNDLE_DATA_DIR "${CMAKE_INSTALL_PREFIX}/data")
set(INSTALL_BUNDLE_LIB_DIR "${CMAKE_INSTALL_PREFIX}")

install(TARGETS ${BINARY_NAME} RUNTIME DESTINATION "${CMAKE_INSTALL_PREFIX}"
  COMPONENT Runtime)

install(FILES "${FLUTTER_ICU_DATA_FILE}" DESTINATION "${INSTALL_BUNDLE_DATA_DIR}"
  COMPONENT Runtime)

install(FILES "${FLUTTER_LIBRARY}" DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
  COMPONENT Runtime)

if(PLUGIN_BUNDLED_LIBRARIES)
  install(FILES "${PLUGIN_BUNDLED_LIBRARIES}"
    DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
    COMPONENT Runtime)
endif()

# Copy the native assets provided by the build.dart from all packages.
set(NATIVE_ASSETS_DIR "${PROJECT_BUILD_DIR}native_assets/windows/")
install(DIRECTORY "${NATIVE_ASSETS_DIR}"
   DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
   COMPONENT Runtime)

# Fully re-copy the assets directory on each build to avoid having stale files
# from a previous install.
set(FLUTTER_ASSET_DIR_NAME "flutter_assets")
install(CODE "
  file(REMOVE_RECURSE \"${INSTALL_BUNDLE_DATA_DIR}/${FLUTTER_ASSET_DIR_NAME}\")
  " COMPONENT Runtime)
install(DIRECTORY "${PROJECT_BUILD_DIR}/${FLUTTER_ASSET_DIR_NAME}"
  DESTINATION "${INSTALL_BUNDLE_DATA_DIR}" COMPONENT Runtime)

# Install the AOT library on non-Debug builds only.
install(FILES "${AOT_LIBRARY}" DESTINATION "${INSTALL_BUNDLE_DATA_DIR}"
  CONFIGURATIONS Profile;Release
  COMPONENT Runtime)

# After every install (flutter build / IDE), mirror the full bundle to
# <repo>/windows_dist/<Config> or NEXTBOT_WINDOWS_DIST (same as build_windows.ps1).
option(NEXTBOT_SKIP_WINDOWS_DIST "Do not copy build output to windows_dist after install" OFF)
if(WIN32 AND NOT NEXTBOT_SKIP_WINDOWS_DIST)
  set(_nextbot_env_dist "$ENV{NEXTBOT_WINDOWS_DIST}")
  string(STRIP "${_nextbot_env_dist}" _nextbot_env_dist)
  # 反斜杠路径（Windows 惯用写法）经 configure_file 原样写进 set() 会变成非法转义
  # （如 \w），INSTALL 阶段才报语法错误——统一换成正斜杠
  string(REPLACE "\\" "/" _nextbot_env_dist "${_nextbot_env_dist}")
  if(_nextbot_env_dist)
    set(NEXTBOT_DEPLOY_ROOT "${_nextbot_env_dist}")
  else()
    get_filename_component(_nextbot_repo_root "${CMAKE_SOURCE_DIR}/../../.." ABSOLUTE)
    set(NEXTBOT_DEPLOY_ROOT "${_nextbot_repo_root}/windows_dist")
  endif()
  if(CMAKE_BUILD_TYPE)
    set(NEXTBOT_DEFAULT_BUILD_TYPE "${CMAKE_BUILD_TYPE}")
  else()
    set(NEXTBOT_DEFAULT_BUILD_TYPE "")
  endif()
  configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/cmake/deploy_windows_dist.cmake.in"
    "${CMAKE_CURRENT_BINARY_DIR}/nextbot_deploy_windows_dist.cmake"
    @ONLY)
  install(SCRIPT "${CMAKE_CURRENT_BINARY_DIR}/nextbot_deploy_windows_dist.cmake")
endif()

cmake_minimum_required(VERSION 3.22.1)
project(node_start CXX)

# Node 不在这里编译: nodejs-mobile 直接给 libnode.so + include/node。
# 两个路径由 build.gradle 用 -D 传进来, 因为那份 .so 有 62MB、头文件上百个, 都不该进仓库。
set(NODEJS_INCLUDE "" CACHE PATH "nodejs-mobile 的 include/node 目录")
set(NODEJS_LIBNODE "" CACHE FILEPATH "nodejs-mobile 的 bin/<abi>/libnode.so")

if(NOT EXISTS "${NODEJS_INCLUDE}/node.h")
    message(FATAL_ERROR "缺 ${NODEJS_INCLUDE}/node.h —— 把 nodejs-mobile-android.zip 解到 /home/tmp/nodejs-mobile")
endif()
if(NOT EXISTS "${NODEJS_LIBNODE}")
    message(FATAL_ERROR "缺 ${NODEJS_LIBNODE} —— 同上, 要 bin/arm64-v8a/libnode.so")
endif()

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION "${NODEJS_LIBNODE}")

add_library(node_start SHARED node_start.cpp)
# node.h 会拉 V8 头, V8 10 要 C++17(NDK 默认 gnu++14 会直接编不过)
target_compile_features(node_start PRIVATE cxx_std_17)
target_include_directories(node_start PRIVATE "${NODEJS_INCLUDE}")
target_link_libraries(node_start PRIVATE log dl node)

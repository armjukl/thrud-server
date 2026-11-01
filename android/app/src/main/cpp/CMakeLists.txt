cmake_minimum_required(VERSION 3.22.1)
project(node_shell CXX)

# Node 不在这里编译: nodejs-mobile 直接给 libnode.so + include/node(路径由 build.gradle -D 传入)。
# 与 :probe 的 CMakeLists 基本同形 —— 两个 Gradle 模块各自认自己的入口, 复制这 20 行比抽一个
# include/ 库模块便宜, 也不会让探针跟着壳一起改。
set(NODEJS_INCLUDE "" CACHE PATH "nodejs-mobile 的 include/node 目录")
set(NODEJS_LIBNODE "" CACHE FILEPATH "nodejs-mobile 的 bin/<abi>/libnode.so")

if(NOT EXISTS "${NODEJS_INCLUDE}/node.h")
    message(FATAL_ERROR "缺 ${NODEJS_INCLUDE}/node.h —— 把 nodejs-mobile-android.zip 解到 /home/tmp/nodejs-mobile")
endif()
if(NOT EXISTS "${NODEJS_LIBNODE}")
    message(FATAL_ERROR "缺 ${NODEJS_LIBNODE}")
endif()

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION "${NODEJS_LIBNODE}")

add_library(node_shell SHARED native-lib.cpp)
# node.h 会拉 V8 头, V8 10 要 C++17(NDK 默认 gnu++14 直接编不过)
target_compile_features(node_shell PRIVATE cxx_std_17)
target_include_directories(node_shell PRIVATE "${NODEJS_INCLUDE}")
target_link_libraries(node_shell PRIVATE log dl node)

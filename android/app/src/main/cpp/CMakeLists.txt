cmake_minimum_required(VERSION 3.22.1)
project(souldew_node)

# LIBNODE_DIR comes from app/build.gradle.kts (nodejs-mobile unpacked there)
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(souldew_node SHARED native-lib.cpp)
target_include_directories(souldew_node PRIVATE ${LIBNODE_DIR}/include/node)
target_link_libraries(souldew_node libnode log)

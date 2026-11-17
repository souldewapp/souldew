// Starts Node (nodejs-mobile, libnode.so) inside the app process. node::Start blocks until Node exits and can run
// only once per process, so NodeService calls this from a dedicated thread and never again.
#include <jni.h>
#include <android/log.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_app_souldew_NodeService_startNode(JNIEnv *env, jclass, jobjectArray args, jobjectArray envPairs) {
    // environment first (PORT, SLS_DATA_DIR, ...): "KEY=VALUE" strings
    jsize ne = env->GetArrayLength(envPairs);
    for (jsize i = 0; i < ne; i++) {
        auto s = (jstring) env->GetObjectArrayElement(envPairs, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        std::string kv(c);
        env->ReleaseStringUTFChars(s, c);
        auto eq = kv.find('=');
        if (eq != std::string::npos) setenv(kv.substr(0, eq).c_str(), kv.substr(eq + 1).c_str(), 1);
    }

    // node wants argv in one contiguous block
    jsize n = env->GetArrayLength(args);
    std::vector<std::string> strs;
    size_t total = 0;
    for (jsize i = 0; i < n; i++) {
        auto s = (jstring) env->GetObjectArrayElement(args, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        strs.emplace_back(c);
        env->ReleaseStringUTFChars(s, c);
        total += strs.back().size() + 1;
    }
    char *block = (char *) calloc(total, 1);
    std::vector<char *> argv;
    char *p = block;
    for (auto &s : strs) {
        memcpy(p, s.c_str(), s.size() + 1);
        argv.push_back(p);
        p += s.size() + 1;
    }
    __android_log_print(ANDROID_LOG_INFO, "souldew", "starting node (%d args)", (int) n);
    int rc = node::Start((int) argv.size(), argv.data());
    __android_log_print(ANDROID_LOG_INFO, "souldew", "node exited: %d", rc);
    return rc;
}

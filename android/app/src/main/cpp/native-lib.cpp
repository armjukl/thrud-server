// 壳的 JNI 入口: 把 argv 喂给 node::Start, 顺便把 node 的 stdout/stderr 搬进 logcat。
//
// 日志的正路是管理页(/api/logs 读 data/logs/server.log); 这条 logcat 是给"页面都打不开"
// 时兜底看的 —— 铺盘失败、require 报错、start() 抛异常都只在这条上现形。
#include <jni.h>

#include <android/log.h>
#include <node.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <pthread.h>
#include <string>
#include <vector>

#define TAG "sld-server"

static void *pumpLog(void *arg) {
    const int fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    std::string buf;
    char chunk[4096];
    for (;;) {
        const ssize_t n = read(fd, chunk, sizeof(chunk));
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            break;  // 写端关了(或 node 退出): 收尾这条线程
        }
        buf.append(chunk, static_cast<size_t>(n));
        size_t nl;
        while ((nl = buf.find('\n')) != std::string::npos) {
            __android_log_print(ANDROID_LOG_INFO, TAG, "%.*s", static_cast<int>(nl), buf.data());
            buf.erase(0, nl + 1);
        }
    }
    if (!buf.empty()) __android_log_print(ANDROID_LOG_INFO, TAG, "%s", buf.c_str());
    return nullptr;
}

// 假服的日志面在管理页里, 但 console.log/未捕获异常只认 fd 1/2: 换成管道, 另一条线程逐行搬走。
static void redirectStdoutToLogcat() {
    int pipes[2];
    if (pipe(pipes) != 0) {
        __android_log_print(ANDROID_LOG_WARN, TAG, "pipe() 失败, logcat 这条路没有: %s", strerror(errno));
        return;
    }
    dup2(pipes[1], STDOUT_FILENO);
    dup2(pipes[1], STDERR_FILENO);
    close(pipes[1]);
    pthread_t th;
    if (pthread_create(&th, nullptr, pumpLog, reinterpret_cast<void *>(static_cast<intptr_t>(pipes[0]))) != 0) {
        __android_log_print(ANDROID_LOG_WARN, TAG, "起不了搬运线程: %s", strerror(errno));
        close(pipes[0]);
        return;
    }
    pthread_detach(th);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_sld_offline_server_NodeBridge_nativeRun(JNIEnv *env, jclass /*cls*/, jobjectArray jargv) {
    const jsize n = env->GetArrayLength(jargv);
    // node::Start 运行期一直读这些字符串, 所以用 std::string 持有, 生命周期跟着本函数
    // (node::Start 不返回, 于是这些字符串实际上活到进程结束 —— 这正是我们要的)。
    std::vector<std::string> owned;
    std::vector<char *> argv;
    owned.reserve(n);
    argv.reserve(n);
    for (jsize i = 0; i < n; ++i) {
        auto js = (jstring) env->GetObjectArrayElement(jargv, i);
        const char *utf = env->GetStringUTFChars(js, nullptr);
        owned.emplace_back(utf);
        env->ReleaseStringUTFChars(js, utf);
        env->DeleteLocalRef(js);
    }
    for (auto &s : owned) argv.push_back(const_cast<char *>(s.c_str()));

    redirectStdoutToLogcat();
    const int argc = static_cast<int>(argv.size());
    __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start argc=%d script=%s", argc, argc > 1 ? argv[1] : "-");
    const int code = node::Start(argc, argv.data());
    __android_log_print(ANDROID_LOG_ERROR, TAG, "node::Start 返回 %d: 事件循环排空了, 假服不会再有响应", code);
    return code;
}

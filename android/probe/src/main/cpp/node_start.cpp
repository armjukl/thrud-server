// 探针 APK 的唯一 JNI 入口: 把 Java 传来的 argv 喂给 node::Start。
//
// node::Start 阻塞到事件循环排空, 且收尾路径会走到 exit() —— 所以 Java 侧必须
// (1)在独立线程上调用它(线程栈给足, V8 对栈深很敏感) (2)别让脚本自然跑完,
// 探针脚本末尾挂一个 ref 定时器把循环钉住, 结果写文件由 UI 轮询读回。
#include <jni.h>

#include <android/log.h>
#include <node.h>

#include <string>
#include <vector>

#define TAG "sld-probe"

extern "C" JNIEXPORT jint JNICALL
Java_com_sld_offline_probe_ProbeActivity_nativeRun(JNIEnv *env, jclass /*cls*/, jobjectArray jargv) {
    const jsize n = env->GetArrayLength(jargv);
    // node::Start 收的是 char**, 且运行期会读这些字符串; 用 std::string 持有, 生命周期跟着本函数。
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

    const int argc = static_cast<int>(argv.size());
    __android_log_print(ANDROID_LOG_INFO, TAG, "node::Start argc=%d script=%s", argc, argc > 1 ? argv[1] : "-");
    const int code = node::Start(argc, argv.data());
    __android_log_print(ANDROID_LOG_WARN, TAG, "node::Start 返回 %d: 事件循环空了, 进程可能随之退出", code);
    return code;
}

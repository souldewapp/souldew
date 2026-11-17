#import "NodeRunner.h"
#import <NodeMobile/NodeMobile.h>

@implementation NodeRunner

+ (void)startEngineWithArguments:(NSArray<NSString *> *)arguments {
    // node wants argv in one contiguous block
    size_t total = 0;
    for (NSString *a in arguments) total += strlen(a.UTF8String) + 1;
    char *block = (char *)calloc(total, sizeof(char));
    char **argv = (char **)calloc(arguments.count + 1, sizeof(char *));
    char *p = block;
    int argc = 0;
    for (NSString *a in arguments) {
        const char *c = a.UTF8String;
        strcpy(p, c);
        argv[argc++] = p;
        p += strlen(c) + 1;
    }
    node_start(argc, argv);
    free(argv);
    free(block);
}

@end

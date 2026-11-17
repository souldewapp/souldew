#import <Foundation/Foundation.h>

/// Starts Node (nodejs-mobile) in this process. node_start blocks until Node exits and works once per process: call it
/// from a thread with a big stack and never again.
@interface NodeRunner : NSObject
+ (void)startEngineWithArguments:(NSArray<NSString *> *)arguments;
@end

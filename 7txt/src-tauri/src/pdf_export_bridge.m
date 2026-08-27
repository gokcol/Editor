// macOS-only clean PDF exporter for 7TXT.
//
// Rendering through an off-screen WKWebView keeps the output local and
// bypasses the user print panel entirely. That means no print headers,
// footers, or editor chrome enter the saved document.

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#import <dispatch/dispatch.h>
#import <math.h>
#import <stdbool.h>
#import <stdlib.h>
#import <string.h>

static const NSTimeInterval SevenTxtPdfExportTimeout = 30.0;
static const CGFloat SevenTxtPdfPageWidth = 595.276; // A4 width in points.
static const CGFloat SevenTxtPdfMinimumHeight = 841.89;

@interface SevenTxtPdfRenderer : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) NSURL *inputURL;
@property(nonatomic, strong) NSURL *outputURL;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) BOOL succeeded;
@property(nonatomic, copy) NSString *failureMessage;
@end

@implementation SevenTxtPdfRenderer

- (instancetype)initWithInputURL:(NSURL *)inputURL outputURL:(NSURL *)outputURL {
  self = [super init];
  if (self) {
    _inputURL = inputURL;
    _outputURL = outputURL;
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    _webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, SevenTxtPdfPageWidth, SevenTxtPdfMinimumHeight)
                                  configuration:configuration];
    _webView.navigationDelegate = self;
  }
  return self;
}

- (void)finishWithMessage:(NSString *)message {
  if (_finished) return;
  _failureMessage = message.length > 0 ? message : @"macOS could not render the document.";
  _finished = YES;
}

- (void)finishWithError:(NSError *)error {
  [self finishWithMessage:error.localizedDescription ?: @"macOS could not render the document."];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [self measureAndWritePdf];
  });
}

- (void)webView:(WKWebView *)webView
didFailProvisionalNavigation:(WKNavigation *)navigation
       withError:(NSError *)error {
  [self finishWithError:error];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self finishWithError:error];
}

- (void)measureAndWritePdf {
  if (_finished) return;
  NSString *script =
      @"Math.ceil(Math.max("
       "document.body ? document.body.scrollHeight : 0, "
       "document.documentElement ? document.documentElement.scrollHeight : 0))";
  __weak typeof(self) weakSelf = self;
  [_webView evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
    SevenTxtPdfRenderer *strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.finished) return;
    if (error != nil) {
      [strongSelf finishWithError:error];
      return;
    }
    CGFloat documentHeight = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : 0.0;
    if (!isfinite(documentHeight) || documentHeight <= 0.0) {
      [strongSelf finishWithMessage:@"macOS could not determine the document dimensions."];
      return;
    }
    CGFloat outputHeight = MAX(documentHeight, SevenTxtPdfMinimumHeight);
    strongSelf.webView.frame = NSMakeRect(0, 0, SevenTxtPdfPageWidth, outputHeight);
    WKPDFConfiguration *configuration = [[WKPDFConfiguration alloc] init];
    configuration.rect = strongSelf.webView.bounds;
    [strongSelf.webView createPDFWithConfiguration:configuration
                                  completionHandler:^(NSData *pdfData, NSError *pdfError) {
      if (strongSelf.finished) return;
      if (pdfError != nil || pdfData.length == 0) {
        [strongSelf finishWithError:pdfError ?: [NSError errorWithDomain:@"SevenTxtPDFExport"
                                                                     code:1
                                                                 userInfo:@{NSLocalizedDescriptionKey : @"macOS produced an empty PDF."}]];
        return;
      }
      NSError *writeError = nil;
      if (![pdfData writeToURL:strongSelf.outputURL options:NSDataWritingAtomic error:&writeError]) {
        [strongSelf finishWithError:writeError];
        return;
      }
      strongSelf.succeeded = YES;
      strongSelf.finished = YES;
    }];
  }];
}

- (BOOL)runWithFailureMessage:(NSString * _Nullable * _Nullable)failureMessage {
  [_webView loadFileURL:_inputURL allowingReadAccessToURL:[_inputURL URLByDeletingLastPathComponent]];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:SevenTxtPdfExportTimeout];
  while (!_finished && deadline.timeIntervalSinceNow > 0.0) {
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                          beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (!_finished) [self finishWithMessage:@"Timed out waiting for macOS to render the PDF."];
  [_webView stopLoading];
  _webView.navigationDelegate = nil;
  if (!_succeeded && failureMessage != NULL) *failureMessage = _failureMessage;
  return _succeeded;
}

@end

static char *SevenTxtDuplicateUTF8String(NSString *message) {
  const char *utf8 = [message UTF8String];
  return strdup(utf8 != NULL ? utf8 : "macOS could not render the document.");
}

bool seventxt_pdf_export_render(const char *input_path,
                                const char *output_path,
                                char **error_message) {
  if (error_message != NULL) *error_message = NULL;
  if (input_path == NULL || output_path == NULL) {
    if (error_message != NULL) *error_message = strdup("Invalid PDF export request.");
    return false;
  }

  __block BOOL succeeded = NO;
  __block NSString *failureMessage = nil;
  void (^render)(void) = ^{
    @autoreleasepool {
      [NSApplication sharedApplication];
      NSURL *inputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:input_path]];
      NSURL *outputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:output_path]];
      SevenTxtPdfRenderer *renderer = [[SevenTxtPdfRenderer alloc] initWithInputURL:inputURL outputURL:outputURL];
      succeeded = [renderer runWithFailureMessage:&failureMessage];
    }
  };
  if ([NSThread isMainThread]) render();
  else dispatch_sync(dispatch_get_main_queue(), render);

  if (!succeeded && error_message != NULL) *error_message = SevenTxtDuplicateUTF8String(failureMessage);
  return succeeded;
}

void seventxt_pdf_export_free_error(char *error_message) {
  free(error_message);
}

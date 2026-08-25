// macOS-only WebKit implementation for `html_export.rs`.
//
// This source is compiled into Yedit at build time.  It never launches a
// browser, relies on no runtime compiler, and renders through the same native
// WKWebView technology that Tauri uses on macOS.

#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>

#import <dispatch/dispatch.h>
#import <math.h>
#import <stdbool.h>
#import <stdlib.h>
#import <string.h>

typedef NS_ENUM(NSInteger, YeditHtmlOutputFormat) {
  YeditHtmlOutputFormatPDF = 0,
  YeditHtmlOutputFormatPNG = 1,
};

static const NSTimeInterval YeditHtmlRenderTimeout = 30.0;
static const CGFloat YeditHtmlViewportWidth = 1440.0;
static const CGFloat YeditHtmlViewportHeight = 980.0;
static const CGFloat YeditHtmlMinimumPngHeight = 900.0;
static const CGFloat YeditHtmlMaximumPngHeight = 16000.0;

@interface YeditHtmlRenderer : NSObject <WKNavigationDelegate>
@property(nonatomic, strong) NSURL *inputURL;
@property(nonatomic, strong) NSURL *outputURL;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, assign) YeditHtmlOutputFormat outputFormat;
@property(nonatomic, assign) CGFloat scale;
@property(nonatomic, assign) BOOL finished;
@property(nonatomic, assign) BOOL succeeded;
@property(nonatomic, copy) NSString *failureMessage;
@end

@implementation YeditHtmlRenderer

- (instancetype)initWithInputURL:(NSURL *)inputURL
                        outputURL:(NSURL *)outputURL
                     outputFormat:(YeditHtmlOutputFormat)outputFormat
                            scale:(CGFloat)scale {
  self = [super init];
  if (self) {
    _inputURL = inputURL;
    _outputURL = outputURL;
    _outputFormat = outputFormat;
    _scale = MAX(1.0, MIN(scale, 4.0));

    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    _webView = [[WKWebView alloc]
        initWithFrame:NSMakeRect(0, 0, YeditHtmlViewportWidth, YeditHtmlViewportHeight)
        configuration:configuration];
    _webView.navigationDelegate = self;
  }
  return self;
}

- (void)finishSuccessfully {
  if (_finished) {
    return;
  }
  _succeeded = YES;
  _finished = YES;
}

- (void)finishWithMessage:(NSString *)message {
  if (_finished) {
    return;
  }
  _failureMessage = message.length > 0 ? message : @"Native WebKit could not render the document.";
  _finished = YES;
}

- (void)finishWithError:(NSError *)error {
  [self finishWithMessage:error.localizedDescription ?: @"Native WebKit could not render the document."];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  // A short delay lets layout settle after `didFinishNavigation`, including
  // ordinary local CSS/font work.  It is deliberately bounded by the outer
  // 30-second render deadline.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)),
                 dispatch_get_main_queue(), ^{
    [self measureAndRender];
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

- (void)measureAndRender {
  if (_finished) {
    return;
  }

  NSString *script =
      @"Math.ceil(Math.max("
       "document.body ? document.body.scrollHeight : 0, "
       "document.documentElement ? document.documentElement.scrollHeight : 0))";
  __weak typeof(self) weakSelf = self;
  [_webView evaluateJavaScript:script completionHandler:^(id value, NSError *error) {
    YeditHtmlRenderer *strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.finished) {
      return;
    }
    if (error != nil) {
      [strongSelf finishWithError:error];
      return;
    }
    CGFloat documentHeight = [value respondsToSelector:@selector(doubleValue)] ? [value doubleValue] : 0.0;
    if (!isfinite(documentHeight) || documentHeight <= 0.0) {
      [strongSelf finishWithMessage:@"WebKit could not determine the document's dimensions."];
      return;
    }
    if (strongSelf.outputFormat == YeditHtmlOutputFormatPNG) {
      [strongSelf renderPNGWithDocumentHeight:documentHeight];
    } else {
      [strongSelf renderPDFWithDocumentHeight:documentHeight];
    }
  }];
}

- (void)renderPDFWithDocumentHeight:(CGFloat)documentHeight {
  // WKPDFConfiguration captures the complete scrollable document.  It avoids
  // the system print panel and produces a real PDF without Chromium.
  WKPDFConfiguration *configuration = [[WKPDFConfiguration alloc] init];
  configuration.rect = CGRectMake(0, 0, YeditHtmlViewportWidth, MAX(documentHeight, YeditHtmlViewportHeight));
  __weak typeof(self) weakSelf = self;
  [_webView createPDFWithConfiguration:configuration
                     completionHandler:^(NSData *pdfData, NSError *error) {
    YeditHtmlRenderer *strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.finished) {
      return;
    }
    if (error != nil || pdfData.length == 0) {
      [strongSelf finishWithError:error ?: [NSError errorWithDomain:@"YeditHTMLExport"
                                                               code:1
                                                           userInfo:@{NSLocalizedDescriptionKey : @"WebKit returned an empty PDF."}]];
      return;
    }
    NSError *writeError = nil;
    if (![pdfData writeToURL:strongSelf.outputURL options:NSDataWritingAtomic error:&writeError]) {
      [strongSelf finishWithError:writeError];
      return;
    }
    [strongSelf finishSuccessfully];
  }];
}

- (void)renderPNGWithDocumentHeight:(CGFloat)documentHeight {
  if (documentHeight > YeditHtmlMaximumPngHeight) {
    [self finishWithMessage:@"This document is too tall for a single PNG. Export it as a PDF instead."];
    return;
  }

  CGFloat height = MAX(YeditHtmlMinimumPngHeight, documentHeight + 32.0);
  WKSnapshotConfiguration *configuration = [[WKSnapshotConfiguration alloc] init];
  configuration.rect = CGRectMake(0, 0, YeditHtmlViewportWidth, height);
  configuration.snapshotWidth = @(YeditHtmlViewportWidth * _scale);
  __weak typeof(self) weakSelf = self;
  [_webView takeSnapshotWithConfiguration:configuration
                        completionHandler:^(NSImage *image, NSError *error) {
    YeditHtmlRenderer *strongSelf = weakSelf;
    if (strongSelf == nil || strongSelf.finished) {
      return;
    }
    if (error != nil || image == nil) {
      [strongSelf finishWithError:error ?: [NSError errorWithDomain:@"YeditHTMLExport"
                                                               code:2
                                                           userInfo:@{NSLocalizedDescriptionKey : @"WebKit returned an empty image."}]];
      return;
    }
    NSData *tiffData = image.TIFFRepresentation;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:tiffData];
    NSData *pngData = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (pngData.length == 0) {
      [strongSelf finishWithMessage:@"WebKit could not encode the rendered PNG."];
      return;
    }
    NSError *writeError = nil;
    if (![pngData writeToURL:strongSelf.outputURL options:NSDataWritingAtomic error:&writeError]) {
      [strongSelf finishWithError:writeError];
      return;
    }
    [strongSelf finishSuccessfully];
  }];
}

- (BOOL)runWithFailureMessage:(NSString * _Nullable * _Nullable)failureMessage {
  [_webView loadFileURL:_inputURL allowingReadAccessToURL:[_inputURL URLByDeletingLastPathComponent]];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:YeditHtmlRenderTimeout];
  while (!_finished && deadline.timeIntervalSinceNow > 0.0) {
    [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                          beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  }
  if (!_finished) {
    [self finishWithMessage:@"Timed out waiting for WebKit to render the document."];
  }
  [_webView stopLoading];
  _webView.navigationDelegate = nil;
  if (!_succeeded && failureMessage != NULL) {
    *failureMessage = _failureMessage;
  }
  return _succeeded;
}

@end

static char *YeditDuplicateUTF8String(NSString *message) {
  const char *utf8 = [message UTF8String];
  return strdup(utf8 != NULL ? utf8 : "Native WebKit could not render the document.");
}

bool yedit_html_export_render(const char *input_path,
                              const char *output_path,
                              int output_format,
                              double scale,
                              char **error_message) {
  if (error_message != NULL) {
    *error_message = NULL;
  }
  if (input_path == NULL || output_path == NULL ||
      (output_format != YeditHtmlOutputFormatPDF && output_format != YeditHtmlOutputFormatPNG)) {
    if (error_message != NULL) {
      *error_message = strdup("Invalid native HTML export request.");
    }
    return false;
  }

  __block BOOL succeeded = NO;
  __block NSString *failureMessage = nil;
  void (^render)(void) = ^{
    @autoreleasepool {
      [NSApplication sharedApplication];
      NSURL *inputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:input_path]];
      NSURL *outputURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:output_path]];
      YeditHtmlRenderer *renderer = [[YeditHtmlRenderer alloc]
          initWithInputURL:inputURL
                  outputURL:outputURL
               outputFormat:(YeditHtmlOutputFormat)output_format
                      scale:(CGFloat)scale];
      succeeded = [renderer runWithFailureMessage:&failureMessage];
    }
  };

  // WebKit must be created and driven on the macOS main thread.  Tauri invoke
  // handlers can arrive on a worker thread, while native menu handlers may
  // already be on main; handle both without a deadlock.
  if ([NSThread isMainThread]) {
    render();
  } else {
    dispatch_sync(dispatch_get_main_queue(), render);
  }

  if (!succeeded && error_message != NULL) {
    *error_message = YeditDuplicateUTF8String(failureMessage);
  }
  return succeeded;
}

void yedit_html_export_free_error(char *error_message) {
  free(error_message);
}

import "package:flutter/foundation.dart";

import "visual_recognition_service.dart";
import "mock_visual_recognition_service.dart";

/// 多模态识别服务管理器
class MultimodalRecognitionService {
  static final MultimodalRecognitionService _instance =
      MultimodalRecognitionService._internal();

  factory MultimodalRecognitionService() {
    return _instance;
  }

  MultimodalRecognitionService._internal();

  VisualRecognitionService? _visualService;

  bool _isInitialized = false;
  String? _currentUserId;

  static MultimodalRecognitionService get instance => _instance;

  Future<bool> initialize({String? userId}) async {
    if (_isInitialized) {
      return true;
    }

    try {
      _visualService = MockVisualRecognitionService();
      await _visualService!.initialize();

      _currentUserId = userId;
      _isInitialized = true;

      debugPrint("多模态识别服务初始化成功（面部）");
      return true;
    } catch (e) {
      debugPrint("多模态识别服务初始化失败: $e");
      return false;
    }
  }

  void setCurrentUser(String userId) {
    _currentUserId = userId;
  }

  Future<bool> registerFace({
    required String userId,
    required List<List<double>> faceFeatures,
  }) async {
    if (!_isInitialized || _visualService == null) {
      throw Exception("视觉识别服务未初始化");
    }

    return await _visualService!.registerFace(
      userId: userId,
      faceFeatures: faceFeatures,
    );
  }

  Stream<VisualEvent>? startFaceRecognition({
    required Function(String detectedAction) onDetected,
  }) {
    if (!_isInitialized || _visualService == null) {
      throw Exception("视觉识别服务未初始化");
    }

    if (_currentUserId == null) {
      throw Exception("未设置当前用户ID");
    }

    return _visualService!.startRealTimeRecognition(
      userId: _currentUserId!,
      onDetected: onDetected,
    );
  }

  void stopFaceRecognition() {
    _visualService?.stopRecognition();
  }

  void dispose() {
    stopFaceRecognition();
    _visualService?.dispose();
    _visualService = null;
    _isInitialized = false;
    _currentUserId = null;
  }

  bool get isInitialized => _isInitialized;

  String? get currentUserId => _currentUserId;
}

// This is a basic Flutter widget test.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nextbot/main.dart';

void main() {
  testWidgets('App root smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const PrivateAiApp());
    expect(find.byType(MaterialApp), findsOneWidget);
  });
}

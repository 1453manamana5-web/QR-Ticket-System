
      await saveTerminal(terminal);
      setTerminals(current => [...current.filter(item => item.terminalId !== firebaseDeviceId), terminal]);
      setForceTerminalRegistration(false);
      setSelectedTerminalId(terminal.terminalId);
      setTerminalNotice(
        isFirstManagementTerminal
          ? "最初の管理端末として自動承認されました。"
          : "この端末の登録申請を送信しました。管理者の承認を待ってください。"
      );
    } catch (reason) {
      console.error("Firebase terminal registration failed", reason);
      setTerminalNotice("端末の登録申請に失敗しました。Firebaseへの接続を確認してください。");
    }
  };

  const refreshTerminalState = () => {
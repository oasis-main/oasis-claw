# oasis-freecad addon GUI init (CLAW-117). Runs only when the FreeCAD GUI is up.
#
# Starts the FreeCADMCP XML-RPC server on the Qt event loop. It binds
# 127.0.0.1 only: remote connections stay at the addon default (off), and
# nothing outside this container can reach port 9875. The upstream workbench
# (menu + toolbar for a human) is deliberately not registered: no human uses
# this FreeCAD's GUI.
import FreeCAD

try:
    from PySide import QtCore as _QtCore
    from rpc_server import rpc_server as _rpc

    # Upstream re-schedules _sync_remote_toggle_state every 2 s until it finds
    # the "Remote Connections" menu action. That action exists only in the
    # workbench, which is not registered here, so the retry would run for the
    # life of the process. The retry looks the name up in the module globals.
    _rpc._sync_remote_toggle_state = lambda: None

    def _oasis_start_rpc():
        try:
            FreeCAD.Console.PrintMessage(f"[oasis-freecad] {_rpc.start_rpc_server()}\n")
        except Exception as _exc:  # noqa: BLE001
            FreeCAD.Console.PrintError(f"[oasis-freecad] RPC start failed: {_exc}\n")

    _QtCore.QTimer.singleShot(1000, _oasis_start_rpc)
except Exception as _exc:  # noqa: BLE001
    FreeCAD.Console.PrintError(f"[oasis-freecad] RPC schedule failed: {_exc}\n")

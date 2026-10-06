# oasis-freecad addon init (CLAW-117). FreeCAD runs this on every launch,
# GUI or not, before the GUI exists.
#
# Preferences for an unattended, memory-lean FreeCAD: no .FCBak backups beside
# saved files (they would land in oasis-hardware), no autosave / recovery
# files (the MCP server's idle reaper does recovery), no Start page.
# The RPC server itself starts from InitGui.py, which runs only once the GUI is up.
import os
import sys

import FreeCAD

_here = os.path.dirname(__file__)
if _here not in sys.path:
    sys.path.insert(0, _here)

_doc = FreeCAD.ParamGet("User parameter:BaseApp/Preferences/Document")
_doc.SetBool("CreateBackupFiles", False)
_doc.SetBool("AutoSaveEnabled", False)
_doc.SetBool("RecoveryEnabled", False)
FreeCAD.ParamGet("User parameter:BaseApp/Preferences/Mod/Start").SetBool("ShowOnStartup", False)
FreeCAD.ParamGet("User parameter:BaseApp/Preferences/General").SetBool("ShowSplasher", False)

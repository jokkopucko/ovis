const MODULE_AND_CLI = String.raw`if sys.argv[1:2] == ['--run-module']:
    import runpy
    if len(sys.argv) < 3: sys.exit('hermes: --run-module needs a module')
    module = sys.argv.pop(2)
    del sys.argv[1]
    runpy.run_module(module, run_name='__main__', alter_sys=True)
    sys.exit(0)
from hermes_cli.main import main
sys.argv[0] = re.sub(r'(-script\.pyw|\.exe)?$', '', sys.argv[0])
sys.exit(main())
`;

// Hermes's POSIX launcher from hermes_cli/_launchers.py at rc.35-v0.21.5, with a scrubbed path.
export const earlierHermesLauncher = `import os, re, sys
os.environ.pop('PYTHONHOME', None)
os.environ.pop('PYTHONPATH', None)
sys.path.insert(0, '/home/u/.hermes/hermes-agent')
if sys.argv[1:2] == ['--print-runtime-command']: sys.dont_write_bytecode = True
from hermes_constants import get_default_hermes_root
os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or str(get_default_hermes_root())
if sys.argv[1:2] == ['--print-runtime-command']:
    from pathlib import Path
    from hermes_cli._launchers import print_runtime_command
    print_runtime_command(Path('/home/u/.hermes/hermes-agent'), sys.argv[2:])
    sys.exit(0)
import hermes_bootstrap
${MODULE_AND_CLI}`;

// Installed launcher with interrupted-update recovery. Only the recovery function and the
// --print-runtime-command body are shortened; neither runs on a successful interactive launch.
const source = `import os, re, sys
import contextlib, hashlib, io, pathlib, shutil, subprocess
os.environ.pop('PYTHONHOME', None)
os.environ.pop('PYTHONPATH', None)
sys.path.insert(0, '/home/u/.hermes/hermes-agent')
def _hermes_closure_repair():
    return
if sys.argv[1:2] == ['--print-runtime-command']:
    sys.exit(0)
sys._hermes_pin_default_home = True
try:
    import hermes_bootstrap
except Exception:
    _hermes_closure_repair()
    raise
if not os.environ.get('HERMES_HOME'):
    from hermes_constants import get_default_hermes_root
    os.environ['HERMES_HOME'] = str(get_default_hermes_root())
${MODULE_AND_CLI}`;

export const hermesLauncherArgv = ["/home/u/.hermes/tools/python/bin/python3", "-I", "-c", source] as const;

///| FFI declarations for native process execution.

///| Execute a command via popen and capture its stdout.
#borrow(cmd)
extern "C" fn capture_output_ffi(cmd : Bytes) -> Bytes = "nas_process_capture_output"

///| Execute a command via system() with inherited stdio. Returns exit code.
#borrow(cmd)
extern "C" fn exec_ffi(cmd : Bytes) -> Int = "nas_process_exec"

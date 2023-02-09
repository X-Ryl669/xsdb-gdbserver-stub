# GDB Server for Xilinx's XSDB (AIEngine)

This is a gdb server implementation over Xilinx's XSDB debugger.

This implementation is specialized for CPU without a native GDB server's implementation (like Microblaze and AI Engines).

AMD/Xilinx hasn't bothered to share a gdb-server for these CPU running in Xilinx's FPGA. Even the LLVM's machine description used in their proprietary compiler (derived from LLVM's compiler) isn't documented. This is very hostile to developers, since it forces to use their hacked and non functional Eclipse environment to develop and debug.

So in order to debug such target, one must use XSDB with its own *weird* interface. 
If you need to use a tool that's using either GDB or LLDB underneath (like Visual Studio Code, QTCreator, ...), the only way is to have a software that's converting the gdbserver's remote protocol to XSDB commmands.

This repository implement such a tool.

## Usage

Once you've cloned this repository and installed all prerequisite (`npm install`), run:

```bash
$ source /path/to/Vitis/settings.sh
$ hw_server -d 
$ #               [port] [xsdb_executable] [work_dir]
$ node src/index.js 2424 xsdb /path/to/aiengine/Work
```

You can then connect to this server with LLDB (for example, like this):

```bash
$ lldb
(lldb) gdb-remote localhost:2424
```

## Limitations

AIEngines code is stored in `Work/aie/core_pos/Release/core_pos` ELF file (`core_pos` is like `23_0`). However, this ELF file doesn't specify the CPU architecture, so it's useless for both LLDB and GDB. 
This means that you can't map PC's address back to source code, nor be able to list the locals variables in your current code.
You can refer to the file `Work/aie/core_pos/Release/core_pos.lst` that contains disassembly of the program (not very convenient).

You can place and remove breakpoints, control CPU execution, fetch and write memory (but not write registers...)


/**
 * Copyright (c) Tatsuo Nomura <tatsuo.nomura@gmail.com>
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { GDBCommandHandler } from './gdb-command-handler.js';
import { ok, stopped, error, currentThreadId, threadIds, ERROR_BAD_ACCESS_SIZE_FOR_ADDRESS, unsupported } from './gdb-server-stub.js';
import Debug from 'debug';
import { spawn } from 'child_process';
import { chunksToLinesAsync, chomp} from '@rauschma/stringio';
import { pipe, split, map} from 'iter-ops';




const trace = Debug('gss:tcf:trace');
const REGISTER_INFO = [
  'name:r0;bitsize:32;offset:0;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r1;bitsize:32;offset:4;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r2;bitsize:32;offset:8;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r3;bitsize:32;offset:12;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r4;bitsize:32;offset:16;encoding:uint;format:hex;set:General Purpose Registers;generic:arg1;',
  'name:r5;bitsize:32;offset:20;encoding:uint;format:hex;set:General Purpose Registers;generic:arg2;',
  'name:r6;bitsize:32;offset:24;encoding:uint;format:hex;set:General Purpose Registers;generic:arg3;',
  'name:r7;bitsize:32;offset:28;encoding:uint;format:hex;set:General Purpose Registers;generic:arg4;',
  'name:r8;bitsize:32;offset:32;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r9;bitsize:32;offset:36;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r10;bitsize:32;offset:40;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r11;bitsize:32;offset:44;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r12;bitsize:32;offset:48;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r13;bitsize:32;offset:52;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r14;bitsize:32;offset:56;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:r15;bitsize:32;offset:60;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:pc;bitsize:32;offset:64;encoding:uint;format:hex;set:General Purpose Registers;generic:pc;',
  'name:fc;bitsize:32;offset:68;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:sp;bitsize:32;offset:72;encoding:uint;format:hex;set:General Purpose Registers;generic:sp;',
  'name:lr;bitsize:32;offset:76;encoding:uint;format:hex;set:General Purpose Registers;generic:lr;',
  'name:md0;bitsize:32;offset:80;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:md1;bitsize:32;offset:84;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:mc0;bitsize:32;offset:88;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:mc1;bitsize:32;offset:92;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:core_control;bitsize:32;offset:96;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:core_status;bitsize:32;offset:100;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:ls;bitsize:32;offset:104;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:le;bitsize:32;offset:108;encoding:uint;format:hex;set:General Purpose Registers;',
  'name:lc;bitsize:32;offset:112;encoding:uint;format:hex;set:General Purpose Registers;',
];

export class XSDB extends GDBCommandHandler {
  constructor(args) {
    super();
    if (!process.env.XILINX_VITIS) {
      throw "This must be called with XILINX_VITIS environment variable set";
    }
    this.debugXSDB = true;
    this.xsdb = spawn(args[0], ['-interactive']);  
    this.launchXSDB(args[1]);
/*    this.memory = new Array(32768).fill(0); // 16KB for program memory and 32KB for data memory

    // Set the initial content of memory just for fun.
    // asm:
    //   li t0
    //   li t1
    //   add t2, t0, t1
    this.handleWriteMemory(0xbfc00000, XSDB._uint32ArrayToBytes([0x200803e8, 0x200907d0, 0x01095020]));
*/
    this.stopAfterCycles = 0;

    this.breakpoints = {};
  }

  splitLine(buffer) {
    const lines = [...pipe(buffer, split(a => a === 10), map(l => Buffer.from(l).toString()))];
    if (this.debugXSDB) console.log("s: " + lines.join("\n"));
    if (lines[lines.length - 1] == 'xsdb% ') return lines.slice(0, lines.length - 1);
    return lines;
  }

  async launchXSDB(workDir) {
    try 
    {
      console.log("BANNER: \n")
      await this.purgeDB(true);
      this.tcfChannel = this.splitLine(await this.queryXSDB('connect'));
      console.log("> " + this.tcfChannel);
  
      this.targets = this.splitLine(await this.queryXSDB('targets -filter {name =~"core*"}'));
      if (!this.targets.length) {
        console.log("Need to init AI engine debug");
        let ret = this.splitLine(await this.queryXSDB('source '+ process.env.XILINX_VITIS + '/scripts/vitis/util/aie_debug_init.tcl', true));
        ret = this.splitLine(await this.queryXSDB('targets -set -nocase -filter {name =~"Versal*"}', true));
        ret = this.splitLine(await this.queryXSDB('init_aie_debug -work-dir {'+workDir+'} -use-current-target -name AIEngine -jtag', true));
        this.targets = this.splitLine(await this.queryXSDB('targets -filter {name =~"core*"}'));
        if (!this.targets.length) {
          throw "Can't find any AI engine core...";
        }
      }
      // Then parse the targets
      let targets = [];
      for (let line of this.targets) {
        const index = parseInt(line.trim());
        const pos = line.slice(line.indexOf('[') + 1);
        const row = parseInt(pos);
        const col = parseInt(pos.slice(pos.indexOf(',')+1));
        const status = pos.slice(pos.indexOf('(')+1, pos.indexOf(')'));
        targets.push({index, row, col, status});
      }
      this.targets = targets;

      console.log("Found " + this.targets.length + " cores:");
      for (let core of this.targets)
        console.log(" " + core.index+ ": "+ core.row + "," + core.col + " => " + core.status);

      console.log("Loading program files in TCF debugger");
      for (let core of this.targets) {
        let ret = this.splitLine(await this.queryXSDB('target ' + core.index, true));
        let coreName = core.row + '_' + core.col;
        ret = this.splitLine(await this.queryXSDB('memmap -file ' + workDir + '/aie/' + coreName + '/Release/' + coreName));
      }
      this.registers = [];
      for (let core of this.targets) {
        this.registers.push({
          r0 : 0, r1 : 0, r2 : 0, r3 : 0, r4 : 0, r5 : 0, r6 : 0, r7 : 0,
          r8 : 0, r9 : 0, r10 : 0, r11 : 0, r12 : 0, r13 : 0, r14 : 0, r15 : 0,          
          pc: 0,
          fc: 0,
          sp: 0,
          lr: 0,
          md0: 0,
          md1: 0,
          mc0: 0,
          mc1: 0,
          core_control: 0,
          core_status: 0,
          ls: 0,
          le: 0,
          lc: 0,
        });
      }
      this.currentThread = 0;
      this.selectThread(this.currentThread);

      console.log("Clearing existing breakpoints");
      let bplist = this.splitLine(await this.queryXSDB('bpr -all', true));

      console.log("Finished preparing the debugger");
    } 
    catch (e)
    {
      console.log("Error: "+ e);
    }

  }

  async purgeDB(print) {
    while (true) {
      let data = await this.queryXSDB('');
      if (data == 'xsdb% ') break;
      if (print) console.log(''+data);
    }
  }

  queryXSDB(input, hideit) {
    if (input) {
      console.log((hideit ? "% " : "< ") + input);
      this.xsdb.stdin.write(input + '\n');
    }

    return new Promise((res, err) => {
      this.xsdb.stdout.once('data', (data)=>{ return res(data);});
      this.xsdb.stderr.once('data', (data)=>{ return res(data);});
    });
  }

  run(cycles) {
    if (this.stopAfterCycles == 0) {
      return;
    }

    let cyclesToRun = Math.min(cycles, this.stopAfterCycles);
    while (cyclesToRun-- > 0) {
      this.stopAfterCycles--;
      this.registers.pc += 4;
      if (this.registers.pc in this.breakpoints) {
        this.stopAfterCycles = 0;
        break;
      }
    }

    if (this.stopAfterCycles == 0) {
      this.emit('stopped', stopped(5));
    }
  }

  handleInterruption() {
    trace('interrupted')
    this.stopAfterCycles = 0;
    this.emit('stopped', stopped(5));
  }

  handleHaltReason() {
    trace('haltReason')
    // Use stop reason SIGTRAP(5).
    return stopped(5);
  }

  async readRegisters(id) {
    let ret = this.splitLine(await this.queryXSDB('rrd'));
    /* Typical output: 
            r0: 00000000                  r1: 00036000                                                                                                                                                 
            r2: 00038200                  r3: 00000000
            r4: ffffffff                  r5: 00000020
            r6: 00032000                  r7: 00000030
            r8: 00000010                  r9: 00000008
            r10: 00000001                 r11: 00000001
            r12: 00000018                 r13: 00000008
            r14: 00000200                 r15: 0003a000
            pc: 000004b0                  fc: 000004c0
            sp: 0002aa00                  lr: 00000280
            md0: 00000000                 md1: 00000000
            mc0: 00000001                 mc1: 00000000
  core_control: 00000001         core_status: 00010001
            ls: 000004a0                  le: 000004d0
            lc: 00000003             pointer          
        config                             s          
      modifier                            cb          
            cs                        vector          
            acc            cm_event_broadcast          
      cm_trace               cm_event_status          
cm_event_group            mm_event_broadcast          
      mm_trace               mm_event_status          
mm_event_group                           dma          
          lock          
    */
    let lines = ret.join(' ');
    while(true) {
      let colon = lines.indexOf(':');
      if (colon == -1) break;
      let regName = lines.slice(lines.lastIndexOf(' ', colon) + 1, colon);
      let regValue = parseInt(lines.slice(colon + 2), 16);
      lines = lines.slice(colon + 10);
      this.registers[id][regName] = regValue;
    }
    console.log(this.registers[id]);
    return this.registers[id];
  }

  handleReadRegisters() {
    trace("readRegisters");
    return this.readRegisters(this.currentThread).then(v => ok(XSDB._uint32ArrayToBytes(Object.values(v))));
    const r = this.registers;
    const values = [...r.gprs, r.sr, r.hi, r.lo, r.bad, r.cause, r.pc];
    return ok(XSDB._uint32ArrayToBytes(values));
  }


  handleReadRegister(index) {
    trace(`readRegister${index}`);
    return this.readRegisters(this.currentThread).then(v => ok(XSDB._uint32ToBytes(Object.values(v)[index])));
  }

  handleWriteRegisters(bytes) {
    trace("writeRegisters");
    const values = XSDB._bytesToInt32Array(bytes);
    // Skip the $zero register.
    for (let i = 1; i < this.registers.gprs.length; i++) {
      this.registers.gprs[i] = values[i];
    }
    this.registers.sr = values[32];
    this.registers.hi = values[33];
    this.registers.lo = values[34];
    this.registers.bad = values[35];
    this.registers.cause = values[36];
    this.registers.pc = values[37];
    return ok();
  }

  async readMemory(a,l) {
    let ret = this.splitLine(await this.queryXSDB('mrd '+a+' '+ (l/4 || 0)));
/* Typical output:
0:   4A66980B
4:   4003C003
8:   CA61CA21
C:   BBFFC7F7
*/
    let lines = ret.map(line => line.slice(line.indexOf(':')+1).trim()).join('');
    console.log(lines);
    // Convert hexdump to byte array
    return ok(lines);
  }


  handleReadMemory(address, length) {
    trace("readMemory");
    return this.readMemory(address, length);

    const start = Math.max(address - 0xbfc00000, 0);
    const end = Math.min(start + length, this.memory.length);
    return ok(this.memory.slice(start, end));
  }

  async writeMemory(a, values) {
    let vals = '{' + values.map(v => '0x' + v.toString(16).padStart(2, "0")).join(',') + '}';
    let ret = this.splitLine(await this.queryXSDB('mwr '+ a +' ' + vals));
    return ok();
  }

  handleWriteMemory(start, values) {
    trace("writeMemory");
    const end = start + values.length;
    if (end > 128*1024) {
      // Bad access size for address
      return error(ERROR_BAD_ACCESS_SIZE_FOR_ADDRESS);
    }
    return this.writeMemory(start, values);

    // Need to set memory on the target
    for (let i = start; i < end; i++) {
      this.memory[i] = values[i - start];
    }
    return ok();
  }

  async step(address) {
    let ret = this.splitLine(await this.queryXSDB('stp'));
    if (ret.length == 0 || !ret[0].includes('Running')) return ok();
    return error(4);
  }

  handleStep(address) {
    trace("step");
    return this.step(address);
    this.stopAfterCycles = 1;
    return ok();
  }

  async cont(address) {
    let ret = this.splitLine(await this.queryXSDB('con' + (address ? '-addr ' + address : '')));
    if (ret.length == 0 || ret[0].includes('unning')) return ok();
    return error(4);
  }

  handleContinue(address) {
    trace("continue");
    return this.cont(address);
    this.stopAfterCycles = Infinity;
    return ok();
  }

  handleQSupported(features) {
    return ok('QStartNoAckMode+;QNonStop+;hwbreak+');
  }

  handleStartNoAckMode() {
    return ok();
  }

  async stopTarget(id) {
    let ret = this.splitLine(await this.queryXSDB('target ' + this.targets[id].index));
    let res = ret.length == 0 || !ret[0].includes('no target with id:');
    if (res) {
      ret = this.splitLine(await this.queryXSDB('stop'));
      await this.purgeDB(false);
      if (ret.length) {
        // Need to do it twice to actually stop the target (don't know why)
        ret = this.splitLine(await this.queryXSDB('stop'));
        await this.purgeDB();
      }
      if (ret.length == 0 || !ret[0].includes('Running'))
      {
        this.targets[id].status = "Suspended";
        return true;
      }
    }
    return false;
  }

  async stopAllTargets() {
    let ret = true;
    for (let i = 0; i < this.targets.length; i++) 
      ret = ret && await this.stopTarget(i);

    if (ret) return ok();
    else return error(3);
  }

  handleNonStop(stopAll) {
    if (stopAll) 
      return this.stopAllTargets();

    return ok();
  }


  handleThreadInfo() {
    return threadIds([... Array(this.targets.length+1).keys()].slice(1));
  }

  async getCurrentThread() {
    let ret = this.splitLine(await this.queryXSDB('targets -filter {name =~"core*"}'));
    for (let line of ret) {
      if (line.includes('*')) {
        let index = parseInt(line.slice(line.lastIndexOf(' ', line.indexOf('*'))+1));
        for (let i = 0; i < this.targets.length; i++)
          if (this.targets[i].index == index) { this.currentThread = i; return i+1; }
      }
    }
    return this.currentThread+1;
  }

  handleCurrentThread() {
    return currentThreadId(this.getCurrentThread());
  }

  handleRegisterInfo(index) {
    trace(`registerInfo:${index}`);
    if (index < REGISTER_INFO.length) {
      return ok(REGISTER_INFO[index]);
    }
    return error(1);
  }

  handleHostInfo() {
    trace('hostInfo');
    // triple:mipsel-unknown-linux-gnu
    return ok('triple:6d697073656c2d756e6b6e6f776e2d6c696e75782d676e75;endian:little;ptrsize:4;');
  }

  handleMemoryRegionInfo(address) {
    trace('memoryRegionInfo');
    return ok('start:00000000;size:20000;permissions:rwx;');
  }
  
  async selectThread(id) {
    id = id - 1;
    if (id < 0) return true; // We don't care about all threads operations anyway
    if (id >= this.targets.length) return false;
    let ret = this.splitLine(await this.queryXSDB('target ' + this.targets[id].index));
    let res = ret.length == 0 || !ret[0].includes('no target with id:');
    if (res) this.currentThread = id;
    return res;
  }

  handleSelectExecutionThread(threadId) {
    if (this.selectThread(threadId))
    {
      trace(`select execution thread:${threadId}`);
      return ok();
    }
    else return error();
  }
  
  handleSelectRegisterThread(threadId) {
    if (this.selectThread(threadId))
    {
      trace(`select register thread:${threadId}`);
      return ok();
    }
    else return error();
  }
  
  handleSelectMemoryThread(threadId) {
    if (this.selectThread(threadId))
    {
      trace(`select memory thread:${threadId}`);
      return ok();
    }
    else return error();
  }

  async addBreakpoints(type, address, kind) {
    let ret = this.splitLine(await this.queryXSDB('bpadd 0x' + address.toString(16)));
    let res = ret.length == 0 || !ret[0].includes('Invalid');
    
    if (res) { this.breakpoints[address] = parseInt(ret[0]); return ok(); }
    else return error(5);
  }

  handleAddBreakpoint(type, address, kind) {
    trace(`addBreakpoint at:${address.toString(16)}`)
    return this.addBreakpoints(type, address, kind);
  }

  async delBreakpoints(type, address, kind) {
    if (address in this.breakpoints) {
      let ret = this.splitLine(await this.queryXSDB('bpremove ' + this.breakpoints[address]));
      delete this.breakpoints[address];
      return ok();
    } return error(1);
  }


  handleRemoveBreakpoint(type, address, kind) {
    trace(`removeBreakpoint at:${address.toString(16)}`)
    return this.delBreakpoints(type, address, kind);
  }

  static _uint32ToBytes(value) {
    if (value < 0)  {
      value = -value + 1;
    }
    return [
      (value >>> 0)  & 0xff,
      (value >>> 8)  & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    ];
  }

  static _uint32ArrayToBytes(values) {
    const bytes = [];
    for (let i = 0; i < values.length; i++) {
      this._uint32ToBytes(values[i]).forEach(x => bytes.push(x));
    }
    return bytes;
  }

  static _bytesToUint32(bytes) {
    // Always end with a >>> 0 so that the number is treated as unsigned int.
    return (((bytes[0] & 0xff) << 0) |
      ((bytes[1] & 0xff) << 8) |
      ((bytes[2] & 0xff) << 16) |
      ((bytes[3] & 0xff) << 24)) >>> 0;
  }

  static _bytesToInt32Array(bytes) {
    const values = [];
    for (let i = 0; i < bytes.length; i += 4) {
      values.push(this._bytesToUint32(bytes.slice(i, i + 4)));
    }
    return values;
  }
}

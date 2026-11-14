import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseOpcodes
	, parseOpline
	, operandParts
	, arrivesAt
	, plainLine
} from '../src/model.mjs';

// What phpdbg's print wrote in the browser runtimes, paused on line 5 inside total(), whose
// foreach runs ops 5 to 11.

/** PHP 8.1 and later: PHP's dumper, on standard error. */
const dumped = [
	''
	, 'total:'
	, '     ; (lines=17, args=1, vars=3, tmps=6)'
	, '     ; /main.php:2-8'

	, 'L0002 0000 CV0($cart) = RECV 1'
	, 'L0003 0001 EXT_STMT'
	, 'L0003 0002 ASSIGN CV1($sum) int(0)'
	, 'L0004 0003 EXT_STMT'
	, 'L0004 0004 V4 = FE_RESET_R CV0($cart) 0012'
	, 'L0004 0005 FE_FETCH_R V4 CV2($item) 0012'

	, 'L0005 0006 EXT_STMT'
	, 'L0005 0007 T5 = FETCH_DIM_R CV2($item) string("price")'
	, 'L0005 0008 T6 = FETCH_DIM_R CV2($item) string("quantity")'
	, 'L0005 0009 T7 = MUL T5 T6'
	, 'L0005 0010 ASSIGN_OP (ADD) CV1($sum) T7'
	, 'L0004 0011 JMP 0005'
	, 'L0004 0012 FE_FREE V4'

	, 'L0007 0013 EXT_STMT'
	, 'L0007 0014 RETURN CV1($sum)'
	, 'L0008 0015 EXT_STMT'
	, 'L0008 0016 RETURN null'
].join('\n');

/** PHP 8.0: phpdbg's own lines, one message each. */
const padded = [
	'Stack in total() (17 ops)'
	, 'L2-8 total() /main.php - 0x23492f0 + 17 ops'

	, ' L2    #0     RECV                    1                                         $cart'
	, ' L3    #1     EXT_STMT'
	, ' L3    #2     ASSIGN                  $sum                 0'
	, ' L4    #3     EXT_STMT'
	, ' L4    #4     FE_RESET_R              $cart                J12                  @1'
	, ' L4    #5     FE_FETCH_R<196>         @1                   $item'

	, ' L5    #6     EXT_STMT'
	, ' L5    #7     FETCH_DIM_R             $item                "price"              ~2'
	, ' L5    #8     FETCH_DIM_R             $item                "quantity"           ~3'
	, ' L5    #9     MUL                     ~2                   ~3                   ~4'
	, ' L5    #10    ASSIGN_OP<1>            $sum                 ~4'
	, ' L4    #11    JMP                     J5'
	, ' L4    #12    FE_FREE                 @1'

	, ' L7    #13    EXT_STMT'
	, ' L7    #14    RETURN                  $sum'
	, ' L8    #15    EXT_STMT'
	, ' L8    #16    RETURN<-1>              null'
].join('\n');

/** Each op that can jump, with the ops it can jump to. */
const jumps = ops => Object.fromEntries(
	ops.filter(op => op.jumps.length).map(op => [`${op.index} ${op.opcode}`, op.jumps])
);

test('the dumper\'s listing is read into a function, its ops and their jumps', () => {
	const [total, ...more] = parseOpcodes(dumped);

	assert.equal(more.length, 0);

	assert.deepEqual(
		{...total, ops: total.ops.length}
		, {
			name: 'total'
			, file: '/main.php'
			, start: 2
			, end: 8

			, info: 'lines=17, args=1, vars=3, tmps=6'
			, address: null
			, ops: 17
		}
	);

	assert.deepEqual(
		total.ops[0]
		, {line: 2, index: 0, result: 'CV0($cart)', opcode: 'RECV', operands: '1', jumps: []}
	);

	assert.deepEqual(
		total.ops[7]
		, {
			line: 5
			, index: 7

			, result: 'T5'
			, opcode: 'FETCH_DIM_R'
			, operands: 'CV2($item) string("price")'
			, jumps: []
		}
	);

	assert.deepEqual(jumps(total.ops), {'4 FE_RESET_R': [12], '5 FE_FETCH_R': [12], '11 JMP': [5]});
	assert.deepEqual(parseOpline('L0005 0006 EXT_STMT\n', [total]), {line: 5, index: 6});
});

test('PHP 8.0\'s columns are read the same way, and its opline found by address', () => {
	const [total] = parseOpcodes(padded);

	assert.deepEqual(
		[total.name, total.file, total.start, total.end, total.address, total.ops.length]
		, ['total', '/main.php', 2, 8, 0x23492f0, 17]
	);

	assert.deepEqual(
		total.ops[4]
		, {
			line: 4
			, index: 4

			, result: '@1'
			, opcode: 'FE_RESET_R'
			, operands: '$cart J12'
			, jumps: [12]
		}
	);

	// The loop's exit is in FE_FETCH_R<196>'s extended value, which is not read as a jump.
	assert.deepEqual(jumps(total.ops), {'4 FE_RESET_R': [12], '11 JMP': [5]});

	// 0x2349398 is six 28-byte ops past the first, and that op is the EXT_STMT on line 5.
	const opline = 'L5            0x2349398 EXT_STMT                         /main.php\n';

	assert.deepEqual(parseOpline(opline, [total]), {line: 5, index: 6});

	// An address that lands on no op with that line and opcode gives the line alone.
	const elsewhere = 'L5            0x2349300 EXT_STMT                         /main.php\n';

	assert.deepEqual(parseOpline(elsewhere, [total]), {line: 5, index: null});
});

/** The jumps operandParts() finds in an op of a function of 20 ops. */
const found = (opcode, operands) => operandParts({opcode, operands}, 20).flatMap(
	part => part.jump ?? []
);

test('only an operand that names an op of the function is a jump', () => {
	assert.deepEqual(found('SWITCH_STRING', 'T1 "a": 0003, "b": 0005, default: 0007'), [3, 5, 7]);
	assert.deepEqual(found('JMP', '0099'), []);
	assert.deepEqual(found('INIT_FCALL', '1 0016 string("total")'), []);
	assert.deepEqual(found('SEND_VAL', 'string("go to 0012") 1'), []);
	assert.deepEqual(found('ECHO', 'int(0012)'), []);

	assert.deepEqual(
		operandParts({opcode: 'JMPZ', operands: 'V4 0012'}, 20)
		, [{text: 'V4 '}, {text: '0012', jump: 12}]
	);
});

test('a class lists each method; the script is {main}; a string may span lines', () => {
	const shop = [
		'User Class: Shop (1 methods)'
		, '\u001b[1;64mprompt>\u001b[0m '
		, ''
		, 'Shop::open:'
		, '     ; (lines=4, args=0, vars=0, tmps=0)'
		, '     ; /main.php:9-9'
		, 'L0009 0000 EXT_STMT'
		, 'L0009 0001 RETURN int(1)'
	].join('\n');

	assert.deepEqual(parseOpcodes(shop).map(listed => listed.name), ['Shop::open']);

	const script = [
		'$_main:'
		, '     ; (lines=13, args=0, vars=1, tmps=7)'
		, '     ; /main.php:1-12'
		, 'L0012 0012 T5 = ROPE_END 2 T6 string("'
		, '")'
		, 'LIVE RANGES:'
		, '     6: 0010 - 0012 (rope)'
	].join('\n');

	const [main] = parseOpcodes(script);

	assert.equal(main.name, '{main}');
	assert.deepEqual(main.ops.map(op => op.operands), ['2 T6 string("\\n")']);
	assert.equal(parseOpcodes('L1-12 {main}() /main.php - 0x2348bd8 + 15 ops')[0].name, '{main}');
});

// What follows was captured from the PHP 8.4 and 8.0 runtimes, for a script made to be awkward;
// the op inside the string below is numbered as the next op would be, the hardest case.

/** phpdbg's own lines for a class that extends Exception: the internal methods it inherits. */
const inherited = [
	'__clone'
	, '__construct'
	, '__wakeup'
	, 'getMessage'
	, 'getCode'
	, 'getFile'

	, 'getLine'
	, 'getTrace'
	, 'getPrevious'
	, 'getTraceAsString'
	, '__toString'
].map(method => `\tInternal Exception::${method}()`);

test('a string may hold what reads as a function or an op, and is still one operand', () => {
	const tricky = [
		''
		, 'App\\tricky:'
		, '     ; (lines=6, args=0, vars=0, tmps=0)'
		, '     ; /main.php:7-10'
		, 'L0007 0000 EXT_STMT'

		, 'L0007 0001 ECHO string("say(\\"hi\\")'
		, 'Options:'
		, 'L0003 0002 RETURN int(9)'
		, '")'
		, 'L0010 0002 EXT_STMT'
		, 'L0010 0003 RETURN int(2)'
		, 'L0010 0004 EXT_STMT'
		, 'L0010 0005 RETURN null'
	].join('\n');

	const [listed, ...others] = parseOpcodes(tricky);

	assert.deepEqual(others, []);
	assert.equal(listed.name, 'App\\tricky');
	assert.deepEqual(listed.ops.map(op => op.index), [0, 1, 2, 3, 4, 5]);

	assert.equal(
		listed.ops[1].operands
		, 'string("say(\\"hi\\")\\nOptions:\\nL0003 0002 RETURN int(9)\\n")'
	);

	assert.deepEqual(listed.ops[3], {
		line: 10
		, index: 3
		, result: ''
		, opcode: 'RETURN'
		, operands: 'int(2)'
		, jumps: []
	});
});

test('a line that only looks like a function or an op is passed over', () => {
	const listing = [
		'total:'
		, '     ; (lines=3, args=0, vars=0, tmps=0)'
		, '     ; /main.php:2-4'
		, 'L0002 0000 EXT_STMT'
		, 'Options:'
		, 'L0009 0007 RETURN int(9)'
		, '     ; /other.php:1-2'
		, 'L0003 0001 RETURN int(1)'
		, 'L0004 0002 RETURN null'
	].join('\n');

	const [listed, ...others] = parseOpcodes(listing);

	assert.deepEqual(others, []);
	assert.deepEqual([listed.file, listed.start, listed.end], ['/main.php', 2, 4]);
	assert.deepEqual(listed.ops.map(op => op.operands), ['', 'int(1)', 'null']);
});

test('the internal methods phpdbg names after a class are no part of an op', () => {
	const dumped = [
		'User Class: App\\Broke (12 methods)'
		, ''
		, 'App\\Broke::why:'
		, '     ; (lines=4, args=0, vars=0, tmps=0)'
		, '     ; /main.php:11-11'
		, 'L0011 0000 EXT_STMT'
		, 'L0011 0001 RETURN string("x")'
		, 'L0011 0002 EXT_STMT'
		, 'L0011 0003 RETURN null'
		, ...inherited
	].join('\n');

	const padded = [
		'User Class: App\\Broke (12 methods)'
		, 'L11-11 App\\Broke::why() /main.php - 0x2351948 + 4 ops'
		, ' L11   #0     EXT_STMT' + ' '.repeat(78)
		, ' L11   #1     RETURN                  "x"' + ' '.repeat(59)
		, ' L11   #2     EXT_STMT' + ' '.repeat(78)
		, ' L11   #3     RETURN<-1>              null' + ' '.repeat(58)
		, ...inherited
	].join('\n');

	for(const [listing, opcode] of [[dumped, 'RETURN'], [padded, 'RETURN<-1>']])
	{
		const [listed, ...others] = parseOpcodes(listing);

		assert.deepEqual(others, []);
		assert.equal(listed.name, 'App\\Broke::why');

		assert.deepEqual(listed.ops.at(-1), {
			line: 11
			, index: 3
			, result: ''
			, opcode
			, operands: 'null'
			, jumps: []
		});
	}

	// A class with no PHP of its own lists nothing.
	assert.deepEqual(parseOpcodes('User Class: App\\Plain (0 methods)\n'), []);

	assert.deepEqual(
		parseOpcodes(['Internal Class: Exception (11 methods)', ...inherited].join('\n'))
		, []
	);
});

test('PHP 8.0: an opcode longer than its column moves the columns after it along', () => {
	const stack = [
		'Stack in App\\total() (21 ops)'
		, 'L14-17 App\\total() /main.php - 0x2352250 + 21 ops'
		, ' L14   #0     RECV                    1                                         $n'
		, ' L15   #1     EXT_STMT'
		, ' L15   #2     ASSIGN                  $aVeryLongVariableN+ "a fairly long str"+'
		, ' L16   #3     EXT_STMT'
		, ' L16   #4     INIT_NS_FCALL_BY_NAME<1>                      "App\\\\strlen"'

		, ' L16   #5     SEND_VAL_EX             "abc"                1'
		, ' L16   #6     EXT_FCALL_BEGIN'
		, ' L16   #7     DO_FCALL                                                          @1'
		, ' L16   #8     EXT_FCALL_END'
		, ' L16   #9     INIT_STATIC_METHOD_CALL<1> "App\\\\Bag"           "put"'

		, ' L16   #10    SEND_VAL                "q"                  1'
		, ' L16   #11    EXT_FCALL_BEGIN'
		, ' L16   #12    DO_FCALL                                                          @2'
		, ' L16   #13    EXT_FCALL_END'
		, ' L16   #14    ADD                     @1                   @2                   ~3'
	].join('\n');

	const functions = parseOpcodes(stack);
	const [{ops}] = functions;

	/** An op as its opcode, operands and result. */
	const brief = index => [ops[index].opcode, ops[index].operands, ops[index].result];

	assert.deepEqual(brief(0), ['RECV', '1', '$n']);
	assert.deepEqual(brief(2), ['ASSIGN', '$aVeryLongVariableN+ "a fairly long str"+', '']);
	assert.deepEqual(brief(4), ['INIT_NS_FCALL_BY_NAME<1>', '"App\\\\strlen"', '']);
	assert.deepEqual(brief(7), ['DO_FCALL', '', '@1']);
	assert.deepEqual(brief(9), ['INIT_STATIC_METHOD_CALL<1>', '"App\\\\Bag" "put"', '']);
	assert.deepEqual(brief(14), ['ADD', '@1 @2', '~3']);

	// The opline of op 9, as phpdbg prints it: the same columns, 28 bytes of address an op.
	const opline = 'L16           0x235234c INIT_STATIC_METHOD_CALL<1> "App\\\\Bag"           "put"'
		+ ' '.repeat(37) + '/main.php';

	assert.deepEqual(parseOpline(opline, functions), {line: 16, index: 9});
});

test('PHP 8.0 pads a column in bytes; a carriage return is shown as PHP writes it', () => {
	const padded = [
		'L2-5 f() /main.php - 0x2348860 + 10 ops'
		, ' L2    #0     RECV                    1                                         $café'
		, ' L3    #1     EXT_STMT'
		, ' L3    #2     CONCAT                  $café               "  "                 ~0'
		, ' L3    #3     CONCAT                  ~0                   "cr  me br  l  e, "+ ~1'
		, ' L3    #4     ASSIGN                  $naïve              ~1'
	].join('\n');

	const [{ops}] = parseOpcodes(padded);

	assert.deepEqual(
		ops.map(op => [op.opcode, op.operands, op.result])
		, [
			['RECV', '1', '$café']
			, ['EXT_STMT', '', '']
			, ['CONCAT', '$café "  "', '~0']
			, ['CONCAT', '~0 "cr  me br  l  e, "+', '~1']
			, ['ASSIGN', '$naïve ~1', '']
		]
	);

	const dumped = [
		'f:'
		, '     ; (lines=6, args=1, vars=1, tmps=1)'
		, '     ; /main.php:2-4'
		, 'L0002 0000 CV0($a) = RECV 1'
		, 'L0003 0001 EXT_STMT'
		, 'L0003 0002 T1 = CONCAT CV0($a) string("x\r'
		, 'y")'
		, 'L0003 0003 RETURN T1'
	].join('\n');

	const [listed] = parseOpcodes(dumped);

	assert.deepEqual(listed.ops.map(op => op.index), [0, 1, 2, 3]);
	assert.equal(listed.ops[2].operands, 'CV0($a) string("x\\r\\ny")');
});

test('a key of a jump table may hold a line break, and its targets are still jumps', () => {
	const choose = [
		''
		, 'choose:'
		, '     ; (lines=12, args=1, vars=1, tmps=2)'
		, '     ; /main.php:2-4'
		, 'L0002 0000 CV0($x) = RECV 1'
		, 'L0003 0001 EXT_STMT'
		, 'L0003 0002 MATCH CV0($x) "a'
		, 'b": 0003, "z": 0005, default: 0007'

		, 'L0003 0003 T2 = QM_ASSIGN int(1)'
		, 'L0003 0004 JMP 0009'
		, 'L0003 0005 T2 = QM_ASSIGN int(2)'
		, 'L0003 0006 JMP 0009'
		, 'L0003 0007 T2 = QM_ASSIGN int(3)'
		, 'L0003 0008 JMP 0009'
		, 'L0003 0009 RETURN T2'

		, 'L0004 0010 EXT_STMT'
		, 'L0004 0011 RETURN null'
	].join('\n');

	const [{ops}] = parseOpcodes(choose);

	assert.equal(ops.length, 12);
	assert.equal(ops[2].operands, 'CV0($x) "a\\nb": 0003, "z": 0005, default: 0007');
	assert.deepEqual(ops[2].jumps, [3, 5, 7]);
});

test('an op is an arrival at its line unless its statement was on the line before it', () => {

	/** Ops from "line opcode" words, numbered in order. */
	const ops = (...words) => words.map((word, index) => {
		const [line, opcode] = word.split(' ');

		return {line: Number(line), index, opcode};
	});

	// $x = foo(   on line 5, with $a on line 6 and $b on line 7: phpdbg reports line 7 again
	// when the call returns, and line 5 again for the assignment.
	const call = ops(
		'5 EXT_STMT', '5 INIT_FCALL', '6 SEND_VAR', '7 SEND_VAR', '7 EXT_FCALL_BEGIN'
		, '7 DO_FCALL', '7 EXT_FCALL_END', '5 ASSIGN', '9 EXT_STMT', '9 RETURN'
	);

	assert.deepEqual(
		call.map((op, index) => arrivesAt(call, index))
		, [true, false, true, true, false, false, false, false, true, false]
	);

	// Lines 5 and 7 can be come back to; line 6 and line 9 can only be arrived at.
	assert.deepEqual([5, 6, 7, 9].map(line => plainLine(call, line)), [false, true, false, true]);

	// A loop: its body on line 7, and its own line 6, come round again as arrivals each time.
	const loop = ops(
		'6 EXT_STMT', '6 ASSIGN', '6 JMP', '7 EXT_STMT', '7 ASSIGN_OP', '6 PRE_INC'
		, '6 IS_SMALLER', '6 JMPNZ', '8 EXT_STMT'
	);

	assert.equal(arrivesAt(loop, 5), true);
	assert.deepEqual([6, 7].map(line => plainLine(loop, line)), [true, true]);

	// PHP 8.0 writes a number after some opcodes; a call is a call with one.
	assert.equal(plainLine(ops('3 EXT_STMT', '3 DO_FCALL<1>', '3 EXT_FCALL_END'), 3), false);
});

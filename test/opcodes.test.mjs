import test from 'node:test';
import assert from 'node:assert/strict';
import {parseOpcodes, parseOpline, operandParts} from '../src/model.mjs';

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


import fs from 'fs';
import * as babylon from 'babylon';
import traverse from 'babel-traverse';
import curry from 'lodash.curry';
import uniq from 'lodash.uniq';
import glob from 'glob';

import { GETTEXT_FUNC_ARGS_MAP, GETTEXT_COMPONENT_PROPS_MAP, BABEL_PARSING_OPTS } from './defaults';
import { outputPot } from './io';
import { toPot } from './json2pot';
import { isGettextFuncCall, isGettextComponent, getFuncName, getJSXAttributeValue } from './node-helpers';

const noop = () => {};

const getEmptyBlock = () => {
  return {
    msgctxt: '',
    msgid: null,
    msgstr: [''],
    comments: {
      reference: [],
      translator: [],
    },
  };
};

/**
 * Returns a gettext block given a mapping of component props to gettext
 * props and a JSXOpeningElement node
 */
const getGettextBlockFromComponent = (propsMap, node) => {
  const componentPropsLookup = propsMap[node.name.name];
  const gettextPropNames = Object.keys(componentPropsLookup);

  const propValues = node.attributes
    .filter(attr => gettextPropNames.indexOf(attr.name.name) !== -1)
    .reduce((props, attr) => ({ ...props, [attr.name.name]: getJSXAttributeValue(attr) }), {});

  const block = Object.keys(propValues)
    .reduce((currBlock, propName) => {
      const gettextVar = componentPropsLookup[propName];
      const value = propValues[propName];

      if (gettextVar === 'msgid') {
        currBlock.msgid = value;
      }
      else if (gettextVar === 'msgid_plural') {
        currBlock.msgid_plural = value;
        currBlock.msgstr = ['', ''];
      }
      else if (gettextVar === 'msgctxt') {
        currBlock.msgctxt = value;
      }
      else if (gettextVar === 'comment') {
        currBlock.comments.translator.push(value);
      }

      return currBlock;
    }, getEmptyBlock());

  return block;
};

/**
 * Returns whether two gettext blocks are considered equal
 */
export const areBlocksEqual = curry((a, b) =>
  (a.msgid === b.msgid && a.msgctxt === b.msgctxt)
);

/**
 * Takes a list of blocks and returns a list with unique ones.
 * Translator comments and source code reference comments are
 * concatenated.
 */
export const getUniqueBlocks = blocks =>
  blocks.reduce((unique, block) => {
    const isEqualBlock = areBlocksEqual(block);
    const existingBlock = unique.filter(x => isEqualBlock(x)).shift();

    if (existingBlock) {

      // Concatenate comments to translators
      if (block.comments.translator.length > 0) {
        existingBlock.comments.translator = uniq(existingBlock.comments.translator.concat(block.comments.translator));
      }

      // Concatenate source references
      if (block.comments.reference.length > 0) {
        existingBlock.comments.reference = uniq(existingBlock.comments.reference.concat(block.comments.reference)).sort();
      }

      // Add plural id and overwrite msgstr
      if (block.msgid_plural) {
        existingBlock.msgid_plural = block.msgid_plural;
        existingBlock.msgstr = block.msgstr;
      }

      return unique.map(x =>  isEqualBlock(x) ? existingBlock : x);
    }

    return unique.concat(block);
  }, []);

/**
 * Traverser
 *
 * The traverser is wrapped inside a function so that it can be used both
 * by passing options manually and as a babel plugin.
 *
 * Options contain component and function mappings, as well as an optional
 * filename, which is used to add source code reference comments to the
 * pot file.
 *
 * Traversers in Babel plugins retrieves plugin options as a `state` argument
 * to each visitor, hence the `state.opts || opts`.
 */
export const getTraverser = (cb = noop, opts = {}) => {
  const messages = [];

  return {
    Program: {
      enter(path, state = {}) {
        state.opts = {
          ...state.opts,
          ...opts,
          filename: state.file ? state.file.opts.filename : opts.filename,
        };
      },

      exit(path, state = {}) {
        cb(getUniqueBlocks(messages), { opts: (state.opts || opts) });
      },
    },

    /**
     * React gettext components, e.g.:
     *
     *  <GetText message="My string" comment="Some clarifying comment" />
     */
    JSXOpeningElement: {
      enter(path, state = {}) {
        const { node, parent } = path;
        const envOpts = state.opts || opts;
        const propsMap = envOpts.componentPropsMap || GETTEXT_COMPONENT_PROPS_MAP;

        if (isGettextComponent(Object.keys(propsMap), node) === false) {
          return;
        }

        if (parent.children.length > 0) {
          return;
        }

        const block = getGettextBlockFromComponent(propsMap, node);

        if (envOpts.filename) {
          block.comments.reference = [`${envOpts.filename}:${node.loc.start.line}`];
        }

        messages.push(block);
      },
    },

    /**
     * React component inline text, e.g.:
     *
     *  <GetText>My string</GetText>
     */
    JSXText: {
      enter(path, state = {}) {
        const { node, parent } = path;
        const envOpts = state.opts || opts;
        const propsMap = envOpts.componentPropsMap || GETTEXT_COMPONENT_PROPS_MAP;

        if (isGettextComponent(Object.keys(propsMap), parent.openingElement) === false) {
          return;
        }

        if (node.value.trim() === '') {
          return;
        }

        const block = getGettextBlockFromComponent(propsMap, parent.openingElement);
        block.msgid = node.value;

        if (envOpts.filename) {
          block.comments.reference = [`${envOpts.filename}:${node.loc.start.line}`];
        }

        messages.push(block);
      },
    },

    /**
     * Gettext function calls, e.g.:
     *
     *   ngettext('One item', '{{ count }} items');
     */
    CallExpression: {
      enter(path, state = {}) {
        const { node } = path;
        const envOpts = state.opts || opts;

        const funcArgsMap = envOpts.funcArgumentsMap || GETTEXT_FUNC_ARGS_MAP;
        const funcNames = Object.keys(funcArgsMap);

        if (isGettextFuncCall(funcNames, node) === false) {
          return;
        }

        const mappedArgs = funcArgsMap[getFuncName(node)];

        const block = mappedArgs
          .map((arg, i) => (arg ? { [arg]: node.arguments[i].value } : null))
          .filter(x => x)
          .reduce((a, b) => ({ ...a, ...b }), getEmptyBlock());

        if (envOpts.filename) {
          block.comments.reference = [`${envOpts.filename}:${node.loc.start.line}`];
        }

        messages.push(block);
      },
    },
  };
};

/**
 * Parses and returns extracted messages from a js contents
 */
export const extractMessages = (code, opts = {}) => {
  let messages = [];

  const ast = babylon.parse(code.toString('utf8'), BABEL_PARSING_OPTS);
  const traverser = getTraverser(_messages => {
    messages = _messages;
  }, opts);

  traverse(ast, traverser);

  return messages;
};

/**
 * Parses and returns extracted messages from a file at a given path
 */
export const extractMessagesFromFile = (file, opts = {}) =>
  extractMessages(fs.readFileSync(file, 'utf8'), {
    ...opts,
    filename: file,
  });

/**
 * Parses and returns extracted messages from all files matching a glob
 */
export const extractMessagesFromGlob = (globStr, opts = {}) => {
  const messages = glob.sync(globStr)
    .reduce((all, file) => all.concat(extractMessagesFromFile(file, opts)), []);

  return getUniqueBlocks(messages);
};

/**
 * Parses a string for gettext messages and writes them to a .pot file
 */
export const parse = (code, opts = {}, cb = noop) => {
  const messages = extractMessages(code);
  outputPot(opts.output, toPot(messages), cb);
};

/**
 * Parses a file at a given path for gettext messages and writes them
 * to a .pot file
 */
export const parseFile = (file, opts = {}, cb = noop) =>
  parse(fs.readFileSync(file, 'utf8'), opts, cb);

/**
 * Parses all files matching a glob and extract messages from all of them,
 * then writing them to a .pot file
 */
export const parseGlob = (globStr, opts = {}, cb = noop) =>
  outputPot(opts.output, toPot(extractMessagesFromGlob(globStr, opts)), cb);

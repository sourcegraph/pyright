import { AnalyzerFileInfo } from 'pyright-internal/analyzer/analyzerFileInfo';
import { getFileInfo } from 'pyright-internal/analyzer/analyzerNodeInfo';
import { ParseTreeWalker } from 'pyright-internal/analyzer/parseTreeWalker';
import { TypeEvaluator } from 'pyright-internal/analyzer/typeEvaluatorTypes';
import { convertOffsetToPosition } from 'pyright-internal/common/positionUtils';
import { TextRange } from 'pyright-internal/common/textRange';
import { TextRangeCollection } from 'pyright-internal/common/textRangeCollection';
import {
    AssignmentNode,
    ClassNode,
    ExpressionNode,
    FunctionNode,
    ImportFromNode,
    ImportNode,
    ModuleNode,
    NameNode,
    ParameterNode,
    ParseNode,
    ParseNodeType,
    TypeAnnotationNode,
} from 'pyright-internal/parser/parseNodes';

import * as lsif from './lsif';
import * as symbols from './symbols';
import {
    metaDescriptor,
    methodDescriptor,
    parameterDescriptor,
    termDescriptor,
    typeDescriptor,
} from './lsif-typescript/Descriptor';
import { LsifSymbol } from './LsifSymbol';
import { Position } from './lsif-typescript/Position';
import { Range } from './lsif-typescript/Range';
import { lsiftyped, LsifConfig } from './lib';
import {
    getDocString,
    getEnclosingClass,
    getEnclosingSuite,
    getFileInfoFromNode,
    isFromImportModuleName,
    isImportModuleName,
} from 'pyright-internal/analyzer/parseTreeUtils';
import {
    ClassType,
    isClass,
    isClassInstance,
    isFunction,
    isModule,
    isTypeVar,
    isUnknown,
    Type,
} from 'pyright-internal/analyzer/types';
import { Counter } from './lsif-typescript/Counter';
import { TypeStubExtendedWriter } from './TypeStubExtendedWriter';
import { SourceFile } from 'pyright-internal/analyzer/sourceFile';
import { extractParameterDocumentation } from 'pyright-internal/analyzer/docStringUtils';
import { isAliasDeclaration, isIntrinsicDeclaration } from 'pyright-internal/analyzer/declaration';
import { ConfigOptions, ExecutionEnvironment } from 'pyright-internal/common/configOptions';
import { versionToString } from 'pyright-internal/common/pythonVersion';
import { Program } from 'pyright-internal/analyzer/program';
import PythonEnvironment from './virtualenv/PythonEnvironment';

//  Useful functions for later, but haven't gotten far enough yet to use them.
//      extractParameterDocumentation

function nameNodeToRange(name: NameNode, lines: TextRangeCollection<TextRange>) {
    const _start = convertOffsetToPosition(name.start, lines);
    const start = new Position(_start.line, _start.character);

    const _end = convertOffsetToPosition(name.start + name.length, lines);
    const end = new Position(_end.line, _end.character);

    return new Range(start, end);
}

export interface TreeVisitorConfig {
    document: lsif.lib.codeintel.lsiftyped.Document;
    sourceFile: SourceFile;
    evaluator: TypeEvaluator;
    program: Program;
    counter: Counter;
    pyrightConfig: ConfigOptions;
    lsifConfig: LsifConfig;
    pythonEnvironment: PythonEnvironment;
}

export class TreeVisitor extends ParseTreeWalker {
    private _fileInfo: AnalyzerFileInfo | undefined;
    private _imports: Map<number, ParseNode>;
    private _symbols: Map<number, LsifSymbol>;

    private _docstringWriter: TypeStubExtendedWriter;

    private _classDepth: number;
    private _functionDepth: number;
    private _lastScope: ParseNode[];
    private _execEnv: ExecutionEnvironment;

    public evaluator: TypeEvaluator;
    public program: Program;
    public document: lsif.lib.codeintel.lsiftyped.Document;

    constructor(public config: TreeVisitorConfig) {
        super();

        this.evaluator = config.evaluator;
        this.program = config.program;
        this.document = config.document;

        // this._filepath = config.sourceFile.getFilePath();

        this._symbols = new Map();
        this._imports = new Map();

        this._docstringWriter = new TypeStubExtendedWriter(this.config.sourceFile, this.evaluator);

        this._classDepth = 0;
        this._functionDepth = 0;
        this._lastScope = [];
        this._execEnv = this.config.pyrightConfig.getExecutionEnvironments()[0];
    }

    override visitModule(node: ModuleNode): boolean {
        this._fileInfo = getFileInfo(node);
        return true;
    }

    override visitClass(node: ClassNode): boolean {
        // This might not even be worth it to be honest...
        this._docstringWriter.visitClass(node);

        const symbol = this.getLsifSymbol(node);

        const stub = this._docstringWriter.docstrings.get(node.id)!;
        const doc = getDocString(node.suite.statements) || '';

        this.document.symbols.push(
            new lsiftyped.SymbolInformation({
                symbol: symbol.value,
                documentation: [...stub, doc],
            })
        );

        this.withScopeNode(node, () => {
            this.walk(node.name);
            this.walk(node.suite);
        });

        return false;
    }

    override visitTypeAnnotation(node: TypeAnnotationNode): boolean {
        // We are close to being able to look up a symbol, which could give us additional information here.
        //  Perhaps we should be using this for additional information for any given name?
        //  We can revisit this in visitName or perhaps when looking up the lsif symbol

        // If we see a type annotation and we are currently inside of a class,
        // that means that we are describing fields of a class (as far as I can tell),
        // so we need to push a new symbol
        if (this.isInsideClass()) {
            this.document.symbols.push(
                new lsiftyped.SymbolInformation({
                    symbol: this.getLsifSymbol(node).value,

                    // TODO: Get the documentation for a type annotation
                    // documentation: ['A Field of a Class'],
                })
            );
        }

        return true;
    }

    override visitAssignment(node: AssignmentNode): boolean {
        // Probably not performant, we should figure out if we can tell that
        // this particular spot is a definition or not, or potentially cache
        // per file or something?
        if (node.leftExpression.nodeType == ParseNodeType.Name) {
            const decls = this.evaluator.getDeclarationsForNameNode(node.leftExpression) || [];
            if (decls.length > 0) {
                let dec = decls[0];
                if (dec.node.parent && dec.node.parent.id == node.id) {
                    this.document.symbols.push(
                        new lsiftyped.SymbolInformation({
                            symbol: this.getLsifSymbol(dec.node).value,
                        })
                    );
                }
            }
        }

        return true;
    }

    private withScopeNode(node: ParseNode, f: () => void): void {
        if (node.nodeType == ParseNodeType.Function) {
            this._functionDepth++;
        } else if (node.nodeType == ParseNodeType.Class) {
            this._classDepth++;
        } else {
            throw 'unsupported scope type';
        }

        const scopeLen = this._lastScope.push(node);

        f();

        // Assert we have a balanced traversal
        if (scopeLen !== this._lastScope.length) {
            throw 'Scopes are not matched';
        }
        this._lastScope.pop();

        if (node.nodeType == ParseNodeType.Function) {
            this._functionDepth--;
        } else if (node.nodeType == ParseNodeType.Class) {
            this._classDepth--;
        } else {
            throw 'unsupported scope type';
        }
    }

    override visitFunction(node: FunctionNode): boolean {
        this._docstringWriter.visitFunction(node);

        let stubs = this._docstringWriter.docstrings.get(node.id)!;
        let functionDoc = getDocString(node.suite.statements) || '';

        this.document.symbols.push(
            new lsiftyped.SymbolInformation({
                symbol: this.getLsifSymbol(node).value,
                documentation: ['```python\n' + stubs.join('\n') + '\n```', functionDoc],
            })
        );

        this.withScopeNode(node, () => {
            // Since we are manually handling various aspects, we need to make sure that we handle
            // - decorators
            // - name
            // - return type
            // - parameters
            node.decorators.forEach((decoratorNode) => this.walk(decoratorNode));
            this.visitName(node.name);
            if (node.returnTypeAnnotation) {
                this.walk(node.returnTypeAnnotation);
            }

            // Walk the parameters individually, with additional information about the function
            node.parameters.forEach((paramNode: ParameterNode) => {
                const symbol = this.getLsifSymbol(paramNode);

                // This pulls documentation of various styles from function docstring
                const paramDocstring = paramNode.name
                    ? extractParameterDocumentation(functionDoc, paramNode.name!.value)
                    : undefined;

                const paramDocumentation = paramDocstring ? [paramDocstring] : undefined;

                this.document.symbols.push(
                    new lsiftyped.SymbolInformation({
                        symbol: symbol.value,
                        documentation: paramDocumentation,
                    })
                );

                // Walk the parameter child nodes
                // TODO: Consider calling these individually so we can pass more metadata directly
                this.walk(paramNode);
            });

            // Walk the function definition
            this.walk(node.suite);
        });

        return false;
    }

    // `import requests`
    override visitImport(node: ImportNode): boolean {
        this._docstringWriter.visitImport(node);

        for (const listNode of node.list) {
            for (const namePart of listNode.module.nameParts) {
                this.pushNewNameNodeOccurence(namePart, symbols.pythonModule(this, namePart, namePart.value));
            }
        }

        return true;
    }

    override visitImportFrom(node: ImportFromNode): boolean {
        for (const importNode of node.imports) {
            this._imports.set(importNode.id, importNode);
        }

        return true;
    }

    override visitName(node: NameNode): boolean {
        const decls = this.evaluator.getDeclarationsForNameNode(node) || [];
        if (decls.length > 0) {
            const dec = decls[0];
            if (!dec.node) {
                return true;
            }

            // TODO: Handle intrinsics more usefully (using declaration probably)
            if (isIntrinsicDeclaration(dec)) {
                this.pushNewNameNodeOccurence(node, this.getBuiltinSymbol(node.value));
                return true;
            }

            if (this._imports.has(dec.node.id)) {
                // TODO: ExpressionNode cast is required?
                const evalutedType = this.evaluator.getType(dec.node as ExpressionNode);
                if (evalutedType) {
                    this.pushTypeReference(node, dec.node, evalutedType!);
                }

                return true;
            }

            // TODO: Write a more rigorous check for if this node is a
            // definition node. Probably some util somewhere already for
            // that (need to explore pyright some more)
            if (dec.node.id == node.parent!.id) {
                this.pushNewNameNodeOccurence(node, this.getLsifSymbol(dec.node), lsiftyped.SymbolRole.Definition);
                return true;
            }

            if (isAliasDeclaration(dec)) {
                this.pushNewNameNodeOccurence(node, this.getLsifSymbol(dec.node));
                return true;
            }

            if (dec.node.id == node.id) {
                const symbol = this.getLsifSymbol(dec.node);
                this.pushNewNameNodeOccurence(node, symbol, lsiftyped.SymbolRole.Definition);
                return true;
            }

            const existingLsifSymbol = this.rawGetLsifSymbol(dec.node);
            if (existingLsifSymbol) {
                this.pushNewNameNodeOccurence(node, existingLsifSymbol, lsiftyped.SymbolRole.ReadAccess);
                return true;
            }

            // TODO: WriteAccess isn't really implemented yet on my side
            // Now this must be a reference, so let's reference the right thing.
            const symbol = this.getLsifSymbol(dec.node);
            this.pushNewNameNodeOccurence(node, symbol);
            return true;
        }

        if (node && (isImportModuleName(node) || isFromImportModuleName(node))) {
            return true;
        }

        const builtinType = this.evaluator.getBuiltInType(node, node.value);
        if (!isUnknown(builtinType)) {
            // TODO: We're still missing documentation for builtin functions,
            // so that's a bit of a shame...

            if (isFunction(builtinType)) {
                this.document.symbols.push(
                    new lsiftyped.SymbolInformation({
                        symbol: this.getBuiltinSymbol(node.value).value,
                        documentation: [builtinType.details.docString || ''],
                    })
                );
            } else {
                this.pushNewNameNodeOccurence(node, this.getBuiltinSymbol(node.value));
            }

            return true;
        } else {
            // let scope = getScopeForNode(node)!;
            // let builtinScope = getBuiltInScope(scope);
        }

        return true;
    }

    private getBuiltinSymbol(name: string): LsifSymbol {
        return LsifSymbol.global(
            LsifSymbol.package('python', versionToString(this._execEnv.pythonVersion)),
            termDescriptor(name)
        );
    }

    private rawGetLsifSymbol(node: ParseNode): LsifSymbol | undefined {
        return this._symbols.get(node.id);
    }

    private rawSetLsifSymbol(node: ParseNode, sym: LsifSymbol): void {
        this._symbols.set(node.id, sym);
    }

    private getLsifSymbol(node: ParseNode): LsifSymbol {
        const existing = this.rawGetLsifSymbol(node);
        if (existing) {
            return existing;
        }

        // not yet right, but good first approximation
        // const scope = getScopeForNode(node)!;
        // if (false && canBeLocal(node) && scope.type != ScopeType.Builtin) {
        //     // const newSymbol = LsifSymbol.local(this.counter.next());
        //     // this._symbols.set(node.id, newSymbol);
        //     // return newSymbol;
        // }

        let newSymbol = this.makeLsifSymbol(node);
        this.rawSetLsifSymbol(node, newSymbol);

        return newSymbol;
    }

    private makeLsifSymbol(node: ParseNode): LsifSymbol {
        switch (node.nodeType) {
            case ParseNodeType.Module:
                const moduleName = getFileInfo(node)!.moduleName;
                if (moduleName == 'builtins') {
                    // TODO: Should get the correct python version for the project here
                    return LsifSymbol.package(moduleName, '3.9');
                }

                // TODO: When we can get versions for different modules, we
                // should use that here to get the correction version (of the other module)
                return LsifSymbol.package(moduleName, this.getVersion(node, moduleName));

            case ParseNodeType.MemberAccess:
                throw 'oh ya';

            case ParseNodeType.Parameter:
                if (!node.name) {
                    console.warn('TODO: Paramerter with no name', node);
                    return LsifSymbol.local(this.config.counter.next());
                }

                return LsifSymbol.global(this.getLsifSymbol(node.parent!), parameterDescriptor(node.name.value));

            case ParseNodeType.Class:
                return LsifSymbol.global(
                    this.getLsifSymbol(node.parent!),
                    typeDescriptor((node as ClassNode).name.value)
                );

            case ParseNodeType.Function:
                let cls = getEnclosingClass(node, false);
                if (cls) {
                    return LsifSymbol.global(
                        this.getLsifSymbol(cls),
                        methodDescriptor((node as FunctionNode).name!.value)
                    );
                }

                return LsifSymbol.global(
                    this.getLsifSymbol(node.parent!),
                    methodDescriptor((node as FunctionNode).name!.value)
                );

            case ParseNodeType.Suite:
                if (node.parent) {
                    return this.getLsifSymbol(node.parent!);
                }

                // TODO: Not sure what to do about this...
                //  I don't know if we ever need to include this at all.
                return LsifSymbol.global(this.getLsifSymbol(node.parent!), metaDescriptor('#'));

            case ParseNodeType.Name:
                return LsifSymbol.global(
                    // TODO(perf)
                    this.getLsifSymbol(getEnclosingSuite(node as ParseNode) || node.parent!),
                    termDescriptor((node as NameNode).value)
                );

            case ParseNodeType.TypeAnnotation:
                switch (node.valueExpression.nodeType) {
                    case ParseNodeType.Name:
                        return LsifSymbol.global(
                            this.getLsifSymbol(getEnclosingSuite(node) || node.parent!),
                            termDescriptor(node.valueExpression.value)
                        );
                    default:
                        throw 'Unhandled type annotation';
                }

            case ParseNodeType.FunctionAnnotation:
                return LsifSymbol.global(
                    this.getLsifSymbol(node.parent!),
                    // Descriptor.term((node as TypeAnnotationNode).typeAnnotation)
                    termDescriptor('FuncAnnotation')
                );

            case ParseNodeType.Decorator:
                throw 'Should not handle decorator directly';

            case ParseNodeType.Assignment:
                // Handle if this variable is in the global scope or not
                // Hard to say for sure (might need to use builtinscope for that?)
                if (this._lastScope.length === 0) {
                    const moduleName = getFileInfo(node)!.moduleName;
                    return LsifSymbol.package(moduleName, this.getVersion(node, moduleName));
                }

                if (this._functionDepth > 0) {
                    // TODO: Check this
                }

                // throw 'what';
                return LsifSymbol.local(this.config.counter.next());

            // TODO: Handle imports better
            // TODO: `ImportAs` is pretty broken it looks like
            case ParseNodeType.ImportAs:
                // @ts-ignore Pretty sure this always is true
                let info = node.module.importInfo;
                return symbols.pythonModule(this, node, info.importName);

            case ParseNodeType.ImportFrom:
                // console.log('from', node);
                return LsifSymbol.empty();

            case ParseNodeType.ImportFromAs:
                // console.log('from as', node);
                return LsifSymbol.empty();

            // Some nodes, it just makes sense to return whatever their parent is.
            case ParseNodeType.With:
            case ParseNodeType.If:
            case ParseNodeType.For:
            // To explore:
            case ParseNodeType.StatementList:
            case ParseNodeType.Tuple:
            case ParseNodeType.ListComprehension:
            case ParseNodeType.ListComprehensionFor:
            case ParseNodeType.ListComprehensionIf:
            case ParseNodeType.Argument:
            case ParseNodeType.BinaryOperation:
                // There is some confusion for me about whether we should do this
                // vs the other idea...
                // return LsifSymbol.empty();

                return this.getLsifSymbol(node.parent!);

            default:
                // throw `Unhandled: ${node.nodeType}\n`;
                console.warn(`Unhandled: ${node.nodeType}`);
                if (!node.parent) {
                    return LsifSymbol.local(this.config.counter.next());
                }

                return this.getLsifSymbol(node.parent!);
        }
    }

    // Take a `Type` from pyright and turn that into an LSIF symbol.
    private typeToSymbol(node: NameNode, typeObj: Type): LsifSymbol {
        if (isFunction(typeObj)) {
            const decl = typeObj.details.declaration;
            if (!decl) {
                // throw 'Unhandled missing declaration for type: function';
                console.warn('Missing Function Decl:', node.token.value, typeObj);
                return LsifSymbol.local(this.config.counter.next());
            }

            return LsifSymbol.global(
                LsifSymbol.package(decl.moduleName, this.getVersion(node, decl.moduleName)),
                methodDescriptor(node.value)
            );
        } else if (isClass(typeObj)) {
            return LsifSymbol.global(
                LsifSymbol.package(typeObj.details.moduleName, this.getVersion(node, typeObj.details.moduleName)),
                typeDescriptor(node.value)
            );
        } else if (isClassInstance(typeObj)) {
            typeObj = typeObj as ClassType;
            throw 'oh yayaya';
            // return LsifSymbol.global(this.getLsifSymbol(decl.node), Descriptor.term(node.value)).value;
        } else if (isTypeVar(typeObj)) {
            throw 'typevar';
        } else if (isModule(typeObj)) {
            // console.log(typeObj);
            // throw `module ${typeObj}`;
            return LsifSymbol.global(
                LsifSymbol.package(typeObj.moduleName, this.getVersion(node, typeObj.moduleName)),
                metaDescriptor('__init__')
            );
        }

        // throw 'unreachable typeObj';
        // const mod = LsifSymbol.sourceFile(this.getPackageSymbol(), [this.fileInfo!.moduleName]);
        // const mod = LsifSymbol.global(this.getPackageSymbol(), packageDescriptor(this.fileInfo!.moduleName));
        // return LsifSymbol.global(mod, termDescriptor(node.value));
        console.warn(`Unreachable TypeObj: ${node.value}: ${typeObj.category}`);
        return LsifSymbol.local(this.config.counter.next());
    }

    // TODO: Could maybe just remove this now.
    private pushTypeReference(node: NameNode, declNode: ParseNode, typeObj: Type): void {
        const symbol = this.typeToSymbol(node, typeObj);
        this.rawSetLsifSymbol(declNode, symbol);
        this.pushNewNameNodeOccurence(node, symbol);
    }

    // Might be the only way we can add new occurrences?
    private pushNewNameNodeOccurence(
        node: NameNode,
        symbol: LsifSymbol,
        role: number = lsiftyped.SymbolRole.ReadAccess
    ): void {
        if (symbol.value.trim() != symbol.value) {
            console.trace(`Invalid symbol dude ${node.value} -> ${symbol.value}`);
        }

        this.document.occurrences.push(
            new lsiftyped.Occurrence({
                symbol_roles: role,
                symbol: symbol.value,
                range: nameNodeToRange(node, this._fileInfo!.lines).toLsif(),
            })
        );
    }

    public getVersion(_node: ParseNode, moduleName: string): string {
        /**
          executionEnvironment: ExecutionEnvironment {
            extraPaths: [],
            root: 'snapshots/input/nested_items',
            pythonVersion: 778,
            pythonPlatform: undefined
          }, */

        let filepath = getFileInfoFromNode(_node)!.filePath;
        this.program.getSourceFile(filepath);
        let packageInfo = this.config.pythonEnvironment.getPackageForModule(filepath, moduleName);
        if (packageInfo) {
            return packageInfo.version;
        }

        // TODO: Maybe this just shouldn't emit a symbol anymore?
        return 'unknown';
    }

    private isInsideClass(): boolean {
        if (this._classDepth == 0) {
            return false;
        }

        return this._lastScope[this._lastScope.length - 1].nodeType == ParseNodeType.Class;
    }
}

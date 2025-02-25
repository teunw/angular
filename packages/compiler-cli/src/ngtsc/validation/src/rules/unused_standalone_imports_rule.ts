/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {ErrorCode, makeDiagnostic, makeRelatedInformation} from '../../../diagnostics';
import type {ImportedSymbolsTracker, Reference} from '../../../imports';
import type {ClassDeclaration} from '../../../reflection';
import type {
  TemplateTypeChecker,
  TypeCheckableDirectiveMeta,
  TypeCheckingConfig,
} from '../../../typecheck/api';

import type {SourceFileValidatorRule} from './api';

/**
 * Rule that flags unused symbols inside of the `imports` array of a component.
 */
export class UnusedStandaloneImportsRule implements SourceFileValidatorRule {
  constructor(
    private templateTypeChecker: TemplateTypeChecker,
    private typeCheckingConfig: TypeCheckingConfig,
    private importedSymbolsTracker: ImportedSymbolsTracker,
  ) {}

  shouldCheck(sourceFile: ts.SourceFile): boolean {
    return (
      this.typeCheckingConfig.unusedStandaloneImports !== 'suppress' &&
      (this.importedSymbolsTracker.hasNamedImport(sourceFile, 'Component', '@angular/core') ||
        this.importedSymbolsTracker.hasNamespaceImport(sourceFile, '@angular/core'))
    );
  }

  checkNode(node: ts.Node): ts.Diagnostic | null {
    if (!ts.isClassDeclaration(node)) {
      return null;
    }

    const metadata = this.templateTypeChecker.getDirectiveMetadata(node);

    if (
      !metadata ||
      !metadata.isStandalone ||
      metadata.rawImports === null ||
      metadata.imports === null ||
      metadata.imports.length === 0
    ) {
      return null;
    }

    const usedDirectives = this.templateTypeChecker.getUsedDirectives(node);
    const usedPipes = this.templateTypeChecker.getUsedPipes(node);

    // These will be null if the component is invalid for some reason.
    if (!usedDirectives || !usedPipes) {
      return null;
    }

    const unused = this.getUnusedSymbols(
      metadata,
      new Set(usedDirectives.map((dir) => dir.ref.node as ts.ClassDeclaration)),
      new Set(usedPipes),
    );

    if (unused === null) {
      return null;
    }

    const category =
      this.typeCheckingConfig.unusedStandaloneImports === 'error'
        ? ts.DiagnosticCategory.Error
        : ts.DiagnosticCategory.Warning;

    if (unused.length === metadata.imports.length) {
      return makeDiagnostic(
        ErrorCode.UNUSED_STANDALONE_IMPORTS,
        this.getDiagnosticNode(metadata.rawImports),
        'All imports are unused',
        undefined,
        category,
      );
    }

    return makeDiagnostic(
      ErrorCode.UNUSED_STANDALONE_IMPORTS,
      this.getDiagnosticNode(metadata.rawImports),
      'Imports array contains unused imports',
      unused.map((ref) => {
        return makeRelatedInformation(
          // Intentionally don't pass a message to `makeRelatedInformation` to make the diagnostic
          // less noisy. The node will already be highlighted so the user can see which node is
          // unused. Note that in the case where an origin can't be resolved, we fall back to
          // the original node's identifier so the user can still see the name. This can happen
          // when the unused is coming from an imports array within the same file.
          ref.getOriginForDiagnostics(metadata.rawImports!, ref.node.name),
          '',
        );
      }),
      category,
    );
  }

  private getUnusedSymbols(
    metadata: TypeCheckableDirectiveMeta,
    usedDirectives: Set<ts.ClassDeclaration>,
    usedPipes: Set<string>,
  ) {
    const {imports, rawImports} = metadata;

    if (imports === null || rawImports === null) {
      return null;
    }

    let unused: Reference<ClassDeclaration>[] | null = null;

    for (const current of imports) {
      const currentNode = current.node as ts.ClassDeclaration;
      const dirMeta = this.templateTypeChecker.getDirectiveMetadata(currentNode);

      if (dirMeta !== null) {
        if (
          dirMeta.isStandalone &&
          !usedDirectives.has(currentNode) &&
          !this.isPotentialSharedReference(current, rawImports)
        ) {
          unused ??= [];
          unused.push(current);
        }
        continue;
      }

      const pipeMeta = this.templateTypeChecker.getPipeMetadata(currentNode);

      if (
        pipeMeta !== null &&
        pipeMeta.isStandalone &&
        !usedPipes.has(pipeMeta.name) &&
        !this.isPotentialSharedReference(current, rawImports)
      ) {
        unused ??= [];
        unused.push(current);
      }
    }

    return unused;
  }

  /**
   * Determines if an import reference *might* be coming from a shared imports array.
   * @param reference Reference to be checked.
   * @param rawImports AST node that defines the `imports` array.
   */
  private isPotentialSharedReference(reference: Reference, rawImports: ts.Expression): boolean {
    // If the reference is defined directly in the `imports` array, it cannot be shared.
    if (reference.getIdentityInExpression(rawImports) !== null) {
      return false;
    }

    // The reference might be shared if it comes from an exported array. If the variable is local
    /// to the file, then it likely isn't shared. Note that this has the potential for false
    // positives if a non-exported array of imports is shared between components in the same
    // file. This scenario is unlikely and even if we report the diagnostic for it, it would be
    // okay since the user only has to refactor components within the same file, rather than the
    // entire application.
    let current: ts.Node | null = reference.getIdentityIn(rawImports.getSourceFile());

    while (current !== null) {
      if (ts.isVariableStatement(current)) {
        return !!current.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      }
      current = current.parent;
    }

    // Otherwise the reference likely comes from an imported
    // symbol like an array of shared common components.
    return true;
  }

  /** Gets the node on which to report the diagnostic. */
  private getDiagnosticNode(importsExpression: ts.Expression): ts.Node {
    let current = importsExpression.parent;

    while (current) {
      // Highlight the `imports:` part of the node instead of the entire node, because
      // imports arrays can be long which makes the diagnostic harder to scan visually.
      if (ts.isPropertyAssignment(current)) {
        return current.name;
      } else {
        current = current.parent;
      }
    }

    return importsExpression;
  }
}

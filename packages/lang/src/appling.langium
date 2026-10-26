grammar Appling

entry Model:
    modules+=Module*;

// Cross cutting

Module:
    'module' name=Ident relevance=Relevance? '{'
        (exports+=Export | members+=Member)*
    '}';

Export:
    'export' names+=Ident (',' names+=Ident)*;

Member:
    Module | Role | Actor | Tenant
    | Enum | ValueType | Entity
    | Event | Action | Machine | Job
    | Query | Projection | External | UseCase
    | Interface
    | Page | Navigation | Flow | Messages
    | Migration;

Role:
    'role' name=Ident relevance=Relevance?;

Actor:
    'actor' kind=('human' | 'system' | 'service') name=Ident
    ('roles' roles+=[Role:QualifiedName] (',' roles+=[Role:QualifiedName])*)? relevance=Relevance?
    ('{' fields+=Field* '}')?;

Tenant:
    'tenant' name=Ident 'on' entity=[Entity:QualifiedName] relevance=Relevance?;

// How much a declaration matters to what the application does; a module's level applies to its members.
Relevance returns string:
    'core' | 'supporting' | 'peripheral';

// L1 Domain

Enum:
    'enum' name=Ident relevance=Relevance? '{' literals+=EnumLiteral* '}';

EnumLiteral:
    name=Ident;

ValueType:
    'value' name=Ident relevance=Relevance? '{' fields+=Field* '}';

Entity:
    'entity' link?='link'? name=Ident relevance=Relevance? '{'
        (fields+=Field | invariants+=Invariant | policies+=Policy)*
    '}';

Field:
    name=Ident ':' type=TypeRef modifiers+=FieldModifier*
    ('default' default=Expr)? ('=' derived=Expr)?;

FieldModifier returns string:
    'unique' | 'state' | 'owned';

TypeRef:
    (primitive=PrimitiveType | decl=[TypeDecl:QualifiedName]) (many?='[' ']')? (optional?='?')?;

PrimitiveType returns string:
    'String' | 'Text' | 'Int' | 'Decimal' | 'Bool' | 'Date' | 'DateTime' | 'Duration' | 'Money' | 'File' | 'Uuid';

type TypeDecl = Enum | ValueType | Entity;

Invariant:
    'invariant' label=STRING '{' condition=Expr '}';

Policy:
    'policy' (operations+=Operation (',' operations+=Operation)*)?
    ('fields' fields+=[Field:Ident] (',' fields+=[Field:Ident])*)?
    '{' condition=Expr '}';

Operation returns string:
    'read' | 'create' | 'update' | 'delete';

// L2 Behavior

Event:
    'event' name=Ident relevance=Relevance? '{' fields+=Field* '}';

Action:
    'action' name=Ident ('on' entity=[Entity:QualifiedName])? relevance=Relevance? '{'
        ('input' '{' inputs+=Param* '}')?
        preconditions+=Precondition*
        ('effect' '{' effects+=Effect* '}')?
        ('errors' errors+=ErrorDecl (',' errors+=ErrorDecl)*)?
        ('consistency' consistency=('atomic' | 'eventual'))?
        policies+=Policy*
    '}';

Param:
    name=Ident ':' type=TypeRef;

ErrorDecl:
    name=Ident;

Precondition:
    'requires' '{' condition=Expr '}' ('else' error=[ErrorDecl:Ident])?;

Effect:
    SetEffect | CreateEffect | EmitEffect;

SetEffect:
    'set' field=[Field:Ident] '=' value=Expr;

CreateEffect:
    'create' entity=[Entity:QualifiedName] '{' (assignments+=Assignment (',' assignments+=Assignment)*)? '}';

EmitEffect:
    'emit' event=[Event:QualifiedName] ('{' (assignments+=Assignment (',' assignments+=Assignment)*)? '}')?;

Assignment:
    name=Ident '=' value=Expr;

Machine:
    'machine' name=Ident 'on' field=[Field:QualifiedName] relevance=Relevance? '{' transitions+=Transition* '}';

Transition:
    'transition' from+=Ident (',' from+=Ident)* '->' to=Ident
    ('via' action=[Action:QualifiedName] | 'on' event=[Event:QualifiedName])
    ('when' '{' guard=Expr '}')?
    ('effect' '{' effects+=Effect* '}')?;

Job:
    'job' name=Ident ('every' schedule=STRING | 'on' event=[Event:QualifiedName])
    'run' action=[Action:QualifiedName] ('where' '{' filter=Expr '}')? relevance=Relevance?;

// L3 Application

Query:
    'query' name=Ident 'from' entity=[Entity:QualifiedName] relevance=Relevance? '{'
        ('where' '{' filter=Expr '}')?
        ('sort' sorts+=Sort (',' sorts+=Sort)*)?
        ('paginate' pageSize=NUMBER)?
        policies+=Policy*
    '}';

Sort:
    field=[Field:Ident] direction=('asc' | 'desc')?;

Projection:
    'projection' name=Ident 'from' source=[ProjectionSource:QualifiedName] relevance=Relevance? '{'
        fields+=ProjectionField*
    '}';

type ProjectionSource = Entity | Query;

ProjectionField:
    name=Ident ('=' value=Expr)?;

External:
    'external' name=Ident relevance=Relevance? '{' operations+=ExternalOperation* '}';

ExternalOperation:
    'op' name=Ident '(' (params+=Param (',' params+=Param)*)? ')'
    ('returns' returns=TypeRef)?
    ('errors' errors+=ErrorDecl (',' errors+=ErrorDecl)*)?;

UseCase:
    'usecase' name=Ident ('(' (params+=Param (',' params+=Param)*)? ')')? relevance=Relevance? '{'
        (steps+=Step | policies+=Policy)*
    '}';

Step:
    CallStep | AwaitStep;

CallStep:
    'step' call=Call handlers+=Handler*;

Handler:
    'on' error=[ErrorDecl:Ident] 'do' call=Call;

AwaitStep:
    'await' event=[Event:QualifiedName] ('timeout' timeout=STRING 'do' call=Call)?;

Call:
    target=[Callable:QualifiedName] '(' (args+=Expr (',' args+=Expr)*)? ')';

type Callable = Action | Query | UseCase | ExternalOperation;

// L4 Interfaces

Interface:
    'interface' protocol=Ident name=Ident relevance=Relevance? '{'
        ('auth' auth=Ident)?
        ('limit' rateLimit=NUMBER 'per' rateUnit=('second' | 'minute' | 'hour'))?
        ('cors' origins+=STRING (',' origins+=STRING)*)?
        endpoints+=Endpoint*
    '}';

Endpoint:
    verb=Ident path=STRING '->' target=[Exposable:QualifiedName]
    ('as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?)?;

type Exposable = Query | Action | UseCase;

// L5 Experience

Page:
    'page' name=Ident 'route' route=STRING relevance=Relevance? '{' components+=Component* '}';

Component:
    ListView | DetailView | FormView;

ListView:
    'list' query=[Query:QualifiedName]
    'as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

DetailView:
    'detail' projection=[Projection:QualifiedName]
    ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

FormView:
    'form' submits=[Submittable:QualifiedName];

type Submittable = Action | UseCase;

Navigation:
    'navigation' name=Ident relevance=Relevance? '{' items+=NavItem* '}';

NavItem:
    label=STRING '->' page=[Page:QualifiedName] ('{' children+=NavItem* '}')?;

Flow:
    'flow' name=Ident 'for' usecase=[UseCase:QualifiedName] relevance=Relevance?
    '{' pages+=[Page:QualifiedName] ('->' pages+=[Page:QualifiedName])* '}';

Messages:
    'messages' name=Ident relevance=Relevance? '{' entries+=Message* '}';

Message:
    key=QualifiedName '=' text=STRING;

// Evolution

Migration:
    'migration' name=Ident '{' steps+=MigrationStep* '}';

// Targets are paths inside the migration's module, as they were before the step.
MigrationStep:
    {infer RenameStep} 'rename' target=QualifiedName '->' newName=Ident
    | {infer RetypeStep} 'retype' target=QualifiedName ':' oldType=TypeRef '->' newType=TypeRef
    | {infer RemoveStep} 'remove' target=QualifiedName;

// Expressions: a CEL subset

Expr:
    OrExpr;

OrExpr infers Expr:
    AndExpr ({infer BinaryExpr.left=current} op='||' right=AndExpr)*;

AndExpr infers Expr:
    RelExpr ({infer BinaryExpr.left=current} op='&&' right=RelExpr)*;

RelExpr infers Expr:
    AddExpr ({infer BinaryExpr.left=current} op=('==' | '!=' | '<=' | '>=' | '<' | '>' | 'in') right=AddExpr)?;

AddExpr infers Expr:
    MulExpr ({infer BinaryExpr.left=current} op=('+' | '-') right=MulExpr)*;

MulExpr infers Expr:
    PrefixExpr ({infer BinaryExpr.left=current} op=('*' | '/' | '%') right=PrefixExpr)*;

PrefixExpr infers Expr:
    {infer UnaryExpr} op=('!' | '-') operand=PrefixExpr
    | PostfixExpr;

PostfixExpr infers Expr:
    PrimaryExpr (
        {infer MemberExpr.receiver=current} '.' member=Ident (call?='(' (args+=Expr (',' args+=Expr)*)? ')')?
        | {infer IndexExpr.receiver=current} '[' index=Expr ']'
    )*;

PrimaryExpr infers Expr:
    '(' Expr ')'
    | {infer ListExpr} '[' (items+=Expr (',' items+=Expr)*)? ']'
    | {infer StringExpr} value=STRING
    | {infer NumberExpr} value=NUMBER
    | {infer BoolExpr} value=('true' | 'false')
    | {infer NullExpr} 'null'
    | {infer NameExpr} name=Ident (call?='(' (args+=Expr (',' args+=Expr)*)? ')')?;

// Names

QualifiedName returns string:
    Ident ('.' Ident)*;

// Keywords that are also valid names, so fields like `state` or `order` stay legal.
Ident returns string:
    ID | 'state' | 'input' | 'value' | 'from' | 'to' | 'on' | 'for' | 'step' | 'list' | 'detail'
    | 'form' | 'route' | 'run' | 'actions' | 'fields' | 'role' | 'event' | 'action' | 'query'
    | 'page' | 'timeout' | 'sort' | 'when' | 'create' | 'read' | 'update' | 'delete' | 'per'
    | 'flow' | 'actor' | 'tenant' | 'set' | 'op' | 'human' | 'system' | 'service' | 'asc'
    | 'desc' | 'remove' | 'rename' | 'retype' | 'roles' | 'second' | 'minute' | 'hour' | 'link'
    | 'core' | 'supporting' | 'peripheral';

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

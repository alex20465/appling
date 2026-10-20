grammar Appling

entry Model:
    modules+=Module*;

// Cross cutting

Module:
    'module' name=Ident id=STABLE_ID? '{'
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
    'role' name=Ident id=STABLE_ID?;

Actor:
    'actor' kind=('human' | 'system' | 'service') name=Ident id=STABLE_ID?
    ('roles' roles+=[Role:QualifiedName] (',' roles+=[Role:QualifiedName])*)?;

Tenant:
    'tenant' name=Ident id=STABLE_ID? 'on' entity=[Entity:QualifiedName];

// L1 Domain

Enum:
    'enum' name=Ident id=STABLE_ID? '{' literals+=EnumLiteral* '}';

EnumLiteral:
    name=Ident id=STABLE_ID?;

ValueType:
    'value' name=Ident id=STABLE_ID? '{' fields+=Field* '}';

Entity:
    'entity' name=Ident id=STABLE_ID? '{'
        (fields+=Field | invariants+=Invariant | policies+=Policy)*
    '}';

Field:
    name=Ident id=STABLE_ID? ':' type=TypeRef modifiers+=FieldModifier*
    ('default' default=Expr)? ('=' derived=Expr)?;

FieldModifier returns string:
    'unique' | 'state' | 'owned';

TypeRef:
    (primitive=PrimitiveType | decl=[TypeDecl:QualifiedName]) (many?='[' ']')? (optional?='?')?;

PrimitiveType returns string:
    'String' | 'Text' | 'Int' | 'Decimal' | 'Bool' | 'Date' | 'DateTime' | 'Duration' | 'Money' | 'File' | 'Uuid';

type TypeDecl = Enum | ValueType | Entity;

Invariant:
    'invariant' label=STRING id=STABLE_ID? '{' condition=Expr '}';

Policy:
    'policy' id=STABLE_ID? (operations+=Operation (',' operations+=Operation)*)?
    ('fields' fields+=[Field:Ident] (',' fields+=[Field:Ident])*)?
    '{' condition=Expr '}';

Operation returns string:
    'read' | 'create' | 'update' | 'delete';

// L2 Behavior

Event:
    'event' name=Ident id=STABLE_ID? '{' fields+=Field* '}';

Action:
    'action' name=Ident id=STABLE_ID? ('on' entity=[Entity:QualifiedName])? '{'
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
    name=Ident id=STABLE_ID?;

Precondition:
    'requires' id=STABLE_ID? '{' condition=Expr '}' ('else' error=[ErrorDecl:Ident])?;

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
    'machine' name=Ident id=STABLE_ID? 'on' field=[Field:QualifiedName] '{' transitions+=Transition* '}';

Transition:
    'transition' id=STABLE_ID? from+=Ident (',' from+=Ident)* '->' to=Ident
    ('via' action=[Action:QualifiedName] | 'on' event=[Event:QualifiedName])
    ('when' '{' guard=Expr '}')?
    ('effect' '{' effects+=Effect* '}')?;

Job:
    'job' name=Ident id=STABLE_ID? ('every' schedule=STRING | 'on' event=[Event:QualifiedName])
    'run' action=[Action:QualifiedName] ('where' '{' filter=Expr '}')?;

// L3 Application

Query:
    'query' name=Ident id=STABLE_ID? 'from' entity=[Entity:QualifiedName] '{'
        ('where' '{' filter=Expr '}')?
        ('sort' sorts+=Sort (',' sorts+=Sort)*)?
        ('paginate' pageSize=NUMBER)?
        policies+=Policy*
    '}';

Sort:
    field=[Field:Ident] direction=('asc' | 'desc')?;

Projection:
    'projection' name=Ident id=STABLE_ID? 'from' source=[ProjectionSource:QualifiedName] '{'
        fields+=ProjectionField*
    '}';

type ProjectionSource = Entity | Query;

ProjectionField:
    name=Ident id=STABLE_ID? ('=' value=Expr)?;

External:
    'external' name=Ident id=STABLE_ID? '{' operations+=ExternalOperation* '}';

ExternalOperation:
    'op' name=Ident id=STABLE_ID? '(' (params+=Param (',' params+=Param)*)? ')'
    ('returns' returns=TypeRef)?
    ('errors' errors+=ErrorDecl (',' errors+=ErrorDecl)*)?;

UseCase:
    'usecase' name=Ident id=STABLE_ID? ('(' (params+=Param (',' params+=Param)*)? ')')? '{'
        (steps+=Step | policies+=Policy)*
    '}';

Step:
    CallStep | AwaitStep;

CallStep:
    'step' id=STABLE_ID? call=Call handlers+=Handler*;

Handler:
    'on' error=[ErrorDecl:Ident] 'do' call=Call;

AwaitStep:
    'await' id=STABLE_ID? event=[Event:QualifiedName] ('timeout' timeout=STRING 'do' call=Call)?;

Call:
    target=[Callable:QualifiedName] '(' (args+=Expr (',' args+=Expr)*)? ')';

type Callable = Action | Query | UseCase | ExternalOperation;

// L4 Interfaces

Interface:
    'interface' protocol=Ident name=Ident id=STABLE_ID? '{'
        ('auth' auth=Ident)?
        ('limit' rateLimit=NUMBER 'per' rateUnit=('second' | 'minute' | 'hour'))?
        ('cors' origins+=STRING (',' origins+=STRING)*)?
        endpoints+=Endpoint*
    '}';

Endpoint:
    verb=Ident path=STRING id=STABLE_ID? '->' target=[Exposable:QualifiedName]
    ('as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?)?;

type Exposable = Query | Action | UseCase;

// L5 Experience

Page:
    'page' name=Ident id=STABLE_ID? 'route' route=STRING '{' components+=Component* '}';

Component:
    ListView | DetailView | FormView;

ListView:
    'list' id=STABLE_ID? query=[Query:QualifiedName]
    'as' projection=[Projection:QualifiedName] ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

DetailView:
    'detail' id=STABLE_ID? projection=[Projection:QualifiedName]
    ('{' picks+=[ProjectionField:Ident] (',' picks+=[ProjectionField:Ident])* '}')?
    ('actions' actions+=[Action:QualifiedName] (',' actions+=[Action:QualifiedName])*)?;

FormView:
    'form' id=STABLE_ID? submits=[Submittable:QualifiedName];

type Submittable = Action | UseCase;

Navigation:
    'navigation' name=Ident id=STABLE_ID? '{' items+=NavItem* '}';

NavItem:
    label=STRING id=STABLE_ID? '->' page=[Page:QualifiedName] ('{' children+=NavItem* '}')?;

Flow:
    'flow' name=Ident id=STABLE_ID? 'for' usecase=[UseCase:QualifiedName]
    '{' pages+=[Page:QualifiedName] ('->' pages+=[Page:QualifiedName])* '}';

Messages:
    'messages' name=Ident id=STABLE_ID? '{' entries+=Message* '}';

Message:
    key=QualifiedName '=' text=STRING;

// Evolution

Migration:
    'migration' name=Ident id=STABLE_ID? '{' steps+=MigrationStep* '}';

MigrationStep:
    {infer RenameStep} 'rename' target=STABLE_ID 'from' oldName=Ident 'to' newName=Ident
    | {infer RetypeStep} 'retype' target=STABLE_ID 'from' oldType=TypeRef 'to' newType=TypeRef
    | {infer RemoveStep} 'remove' target=STABLE_ID;

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
    | 'desc' | 'remove' | 'rename' | 'retype' | 'roles' | 'second' | 'minute' | 'hour';

hidden terminal WS: /\s+/;
terminal STABLE_ID: /#[a-z0-9]+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
